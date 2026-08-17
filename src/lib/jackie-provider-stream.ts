// Unified streaming client — routes to any provider edge function.
// Every provider function returns OpenAI-compatible SSE (`data: {...}\n`).
// Auto-fallback: on 429/402/5xx or missing-secret errors, cascades down
// the FALLBACK_ORDER (Lovable → free → freemium → paid).
//
// Local runners (Ollama) always fail over, even with `fallback` off: a local
// rate limit / overload / refused connection is never a reason for the main
// assistant to stop. Context is auto-captured before every switch.
import type { ProviderId } from "./jackie-providers";
import { findProvider, FALLBACK_ORDER } from "./jackie-providers";
import { supabase } from "@/integrations/supabase/client";
import { captureContext } from "./repair/contextGuard";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

/** Providers that run on the operator's own machine — always worth failing over. */
const LOCAL_PROVIDERS: ProviderId[] = ["ollama"];

const RATE_LIMIT_PATTERNS =
  /(429|rate ?limit|too many requests|overload|busy|model is loading|queue|timeout|timed out|connection refused|econnrefused|fetch failed|unavailable)/i;

export function isRateLimitLike(reason: string) {
  return RATE_LIMIT_PATTERNS.test(reason);
}

/** Auto-save the conversation before a provider/model switch takes it away. */
function guard(args: StreamArgs, from: ProviderId, to: ProviderId, reason: string, partial: string) {
  captureContext({
    reason: "rate-limit-failover",
    from: `${from} · ${args.model}`,
    to,
    detail: reason,
    body: [
      args.system ? `# system\n${args.system}` : "",
      ...args.messages.map((m) => `# ${m.role}\n${m.content}`),
      partial ? `# assistant (partial, before failover)\n${partial}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
}


type StreamArgs = {
  provider: ProviderId;
  model: string;
  messages: ChatMessage[];
  system?: string;
  onDelta: (t: string) => void;
  onDone: (meta?: { servedBy: ProviderId; model: string }) => void;
  onError: (e: string) => void;
  /** Fallback through remaining providers when this one fails. Default: false. */
  fallback?: boolean;
  /** Callback fired when we switch to a fallback provider. */
  onFallback?: (from: ProviderId, to: ProviderId, reason: string) => void;
};

type SingleResult =
  | { kind: "ok" }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

async function tryOne(
  args: StreamArgs,
  provider: ProviderId,
  model: string,
): Promise<SingleResult> {
  const def = findProvider(provider);
  if (!def) return { kind: "fatal", reason: `Unknown provider: ${provider}` };

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { kind: "fatal", reason: "Not signed in." };

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${def.fn}`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ messages: args.messages, model, system: args.system }),
    });
  } catch (e) {
    return { kind: "retryable", reason: e instanceof Error ? e.message : "Network error" };
  }

  if (!resp.ok) {
    const err = await resp.json().catch(() => null);
    const msg = err?.needs_secret
      ? `Missing ${err.needs_secret}`
      : err?.error || `HTTP ${resp.status}`;
    // Retry on missing secret, rate limit, credit, or transient upstream
    const retryable =
      !!err?.needs_secret ||
      resp.status === 429 ||
      resp.status === 402 ||
      resp.status >= 500;
    return retryable ? { kind: "retryable", reason: msg } : { kind: "fatal", reason: msg };
  }

  if (!resp.body) return { kind: "retryable", reason: "No stream body" };

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let gotAnyDelta = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") return { kind: "ok" };
        try {
          const j = JSON.parse(payload);
          const c = j.choices?.[0]?.delta?.content;
          if (c) { args.onDelta(c); gotAnyDelta = true; }
        } catch { /* partial */ }
      }
    }
  } catch (e) {
    // Mid-stream failure: only retry if we haven't emitted anything yet
    if (!gotAnyDelta) {
      return { kind: "retryable", reason: e instanceof Error ? e.message : "Stream broken" };
    }
    return { kind: "fatal", reason: e instanceof Error ? e.message : "Stream broken" };
  }
  return { kind: "ok" };
}

export async function streamProviderChat(args: StreamArgs) {
  const primary = args.provider;
  const first = await tryOne(args, primary, args.model);

  if (first.kind === "ok") {
    args.onDone({ servedBy: primary, model: args.model });
    return;
  }
  if (first.kind === "fatal" || !args.fallback) {
    args.onError(first.reason);
    return;
  }

  // Cascade through remaining providers using each provider's default (first) model.
  const chain = FALLBACK_ORDER.filter((p) => p !== primary);
  let lastReason = first.reason;
  for (const next of chain) {
    const def = findProvider(next);
    if (!def) continue;
    const fallbackModel = def.models[0]?.id;
    if (!fallbackModel) continue;
    args.onFallback?.(primary, next, lastReason);
    const r = await tryOne(args, next, fallbackModel);
    if (r.kind === "ok") {
      args.onDone({ servedBy: next, model: fallbackModel });
      return;
    }
    if (r.kind === "fatal") {
      args.onError(r.reason);
      return;
    }
    lastReason = r.reason;
  }
  args.onError(`All providers failed. Last error: ${lastReason}`);
}
