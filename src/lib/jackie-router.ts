/**
 * Which engine answers, and what happens when it cannot.
 *
 * The chat had one route and no recovery. `streamChat` went to the cloud
 * gateway, and when the gateway said no — no key, no credit, rate limited,
 * unreachable — the send ended in a toast and an empty bubble. Nothing tried
 * anything else, so a rig with its own engine running and a model loaded still
 * had a dead chat.
 *
 * This walks `jackie-engines`' chain instead. It starts at whichever engine is
 * chosen, and on any failure that another engine could plausibly answer it
 * moves down: Jacky → Bionic → Ollama → Cloud. Only two things stop the walk:
 *
 *   - the user aborted, which is not a failure and must not be retried
 *     somewhere else, and
 *   - there is no signed-in session, which every engine would refuse
 *     identically, so trying four of them is four identical errors.
 *
 * A failover is reported through `onRoute` rather than swallowed. An answer
 * that quietly came from somewhere other than the engine named on screen is
 * how a chat ends up lying about what it is.
 *
 * Partial output is not thrown away either: if an engine streamed some tokens
 * and then broke, that text is already on screen, so the router hands the next
 * engine the same history and keeps going rather than restarting the answer on
 * top of what is already there — it reports the break instead, once, with the
 * text intact.
 */
import { streamSse, type ChatMessage } from "@/lib/jackie-stream";
import { callEdgeFunction, describeEdgeFailure, NotSignedInError } from "@/lib/edgeFunction";
import {
  chainFrom,
  findEngine,
  DEFAULT_ENGINE,
  type EngineDef,
  type EngineId,
} from "@/lib/jackie-engines";

export type { ChatMessage };

export interface RouteAttempt {
  engine: EngineId;
  model?: string;
  /** Why the previous engine gave up. Absent on the first attempt. */
  reason?: string;
  /** The engine that just failed, when this attempt is a failover. */
  from?: EngineId;
}

export interface RouteResult {
  engine: EngineId;
  model?: string;
  /** Engines that were tried and failed before this one answered. */
  fellBackFrom: EngineId[];
}

export interface RouteChatOptions {
  messages: ChatMessage[];
  /** Memory, tasks and file summaries, injected into the system prompt. */
  context?: string;
  /** Engine to try first. Defaults to Jacky. */
  engine?: EngineId;
  /** Model for that engine. Ignored by engines that pick their own. */
  model?: string;
  onDelta: (text: string) => void;
  onDone: (result: RouteResult) => void;
  onError: (error: string) => void;
  /** Fired before each attempt, including the first. */
  onRoute?: (attempt: RouteAttempt) => void;
  signal?: AbortSignal;
  /** Walk the rest of the chain on failure. Default true. */
  fallback?: boolean;
  /**
   * How Jacky's one-piece answer is paced onto the screen. Overridable so
   * tests do not wait on real timers.
   */
  pace?: (ms: number) => Promise<void>;
}

type Attempt =
  | { kind: "ok" }
  | { kind: "failed"; reason: string }
  /** Nothing else can help: no session, or the user stopped it. */
  | { kind: "stop"; reason?: string };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Failures that mean "ask someone else", and the one that does not.
 *
 * Every engine in the chain refuses an unauthenticated caller the same way, so
 * a missing session is the only error worth stopping on. Everything else — a
 * missing secret, a refused key, a rate limit, an unreachable host, an empty
 * answer — is a reason to try the next engine, because the next engine is a
 * different machine with different limits.
 */
function isTerminal(reason: string): boolean {
  return /signed out|not signed in|sign in and try again/i.test(reason);
}

/** Jacky answers in one piece. This puts it on screen as if it were typed. */
async function emit(
  text: string,
  onDelta: (t: string) => void,
  signal: AbortSignal | undefined,
  pace: (ms: number) => Promise<void>,
) {
  const size = 24;
  for (let i = 0; i < text.length; i += size) {
    if (signal?.aborted) return;
    onDelta(text.slice(i, i + size));
    await pace(8);
  }
}

interface JackyAnswer {
  response?: unknown;
  engine?: unknown;
  route?: unknown;
  model?: unknown;
  status?: unknown;
}

/**
 * Jacky's turn, through `jacky-proxy`.
 *
 * The proxy's allowlist forwards exactly five calls and `ask` is the one that
 * thinks; it takes a single prompt and answers whole. So the conversation is
 * flattened into that prompt here. The persona is not re-sent — Jacky is the
 * rig's own engine and already has one — but the injected context is, because
 * memory and tasks are the part Jacky has no other way to see.
 */
async function askJacky(
  args: RouteChatOptions,
  pace: (ms: number) => Promise<void>,
): Promise<Attempt> {
  const history = args.messages
    .map((m) => `${m.role === "user" ? "User" : "Jackie"}: ${m.content}`)
    .join("\n\n");
  const prompt = args.context
    ? `## Context Jackie is carrying\n\n${args.context}\n\n## Conversation\n\n${history}`
    : history;

  let resp: Response;
  try {
    resp = await callEdgeFunction(
      "jacky-proxy",
      { path: "ask", method: "POST", body: { prompt, task_type: "general" } },
      { signal: args.signal },
    );
  } catch (e) {
    if (args.signal?.aborted || (e as Error)?.name === "AbortError") {
      return { kind: "stop" };
    }
    const reason = describeEdgeFailure(e, "jacky-proxy");
    return e instanceof NotSignedInError
      ? { kind: "stop", reason }
      : { kind: "failed", reason };
  }

  const body = await resp.json().catch(() => null);
  if (!resp.ok || !body) {
    const detail =
      typeof body?.detail === "string"
        ? body.detail
        : typeof body?.error === "string"
        ? body.error
        : `HTTP ${resp.status}`;
    if (resp.status === 401) return { kind: "stop", reason: "You are signed out, so Jackie cannot answer. Sign in and try again." };
    return { kind: "failed", reason: `Jacky: ${detail}` };
  }

  // `jacky-proxy` wraps the engine's own JSON in `{ ok, status, data }`.
  const envelope = body as { ok?: boolean; error?: string; detail?: string; data?: JackyAnswer };
  if (envelope.error) return { kind: "failed", reason: `Jacky: ${envelope.detail || envelope.error}` };
  if (envelope.ok === false) return { kind: "failed", reason: "Jacky: the engine refused the request." };

  const answer = envelope.data ?? {};
  const text = typeof answer.response === "string" ? answer.response.trim() : "";
  if (!text) return { kind: "failed", reason: "Jacky answered with nothing." };

  await emit(text, args.onDelta, args.signal, pace);
  if (args.signal?.aborted) return { kind: "stop" };
  return { kind: "ok" };
}

/** Any engine whose function answers OpenAI-compatible SSE. */
async function streamEngine(
  args: RouteChatOptions,
  def: EngineDef,
  model: string | undefined,
): Promise<Attempt> {
  let outcome: Attempt = { kind: "failed", reason: "no answer" };
  await streamSse({
    fn: def.fn,
    payload: {
      messages: args.messages,
      ...(model ? { model } : {}),
      ...(args.context ? { context: args.context } : {}),
    },
    onDelta: args.onDelta,
    onDone: () => {
      outcome = { kind: "ok" };
    },
    onError: (reason) => {
      outcome = isTerminal(reason)
        ? { kind: "stop", reason }
        : { kind: "failed", reason: `${def.short}: ${reason}` };
    },
    signal: args.signal,
  });
  // `streamSse` calls neither callback when the user stopped it.
  if (args.signal?.aborted) return { kind: "stop" };
  return outcome;
}

async function attempt(
  args: RouteChatOptions,
  id: EngineId,
  pace: (ms: number) => Promise<void>,
): Promise<{ result: Attempt; model?: string }> {
  const def = findEngine(id);
  if (!def) return { result: { kind: "failed", reason: `Unknown engine: ${id}` } };

  if (def.kind === "jacky") {
    return { result: await askJacky(args, pace) };
  }

  // The chosen model only belongs to the chosen engine. Every engine further
  // down the chain gets its own default, because handing Ollama a Gemini id is
  // a guaranteed second failure.
  const model = id === args.engine ? args.model ?? def.models[0]?.id : def.models[0]?.id;
  const usable = model === "bionic-default" ? undefined : model;
  return { result: await streamEngine(args, def, usable), model: usable };
}

export async function routeChat(args: RouteChatOptions): Promise<void> {
  const pace = args.pace ?? sleep;
  const preferred = findEngine(args.engine) ? (args.engine as EngineId) : DEFAULT_ENGINE;
  const chain = args.fallback === false ? [preferred] : chainFrom(preferred);

  const fellBackFrom: EngineId[] = [];
  let lastReason = "";

  for (const id of chain) {
    if (args.signal?.aborted) return;

    args.onRoute?.({
      engine: id,
      ...(fellBackFrom.length
        ? { reason: lastReason, from: fellBackFrom[fellBackFrom.length - 1] }
        : {}),
    });

    const { result, model } = await attempt(args, id, pace);

    if (result.kind === "ok") {
      args.onDone({ engine: id, model, fellBackFrom: [...fellBackFrom] });
      return;
    }
    if (result.kind === "stop") {
      // Aborts carry no reason and must stay silent — the caller already knows
      // it stopped the answer, and a toast for it reads like a fault.
      if (result.reason) args.onError(result.reason);
      return;
    }

    fellBackFrom.push(id);
    lastReason = result.reason;
  }

  args.onError(
    fellBackFrom.length > 1
      ? `Every engine refused (${fellBackFrom.join(" → ")}). Last: ${lastReason}`
      : lastReason || "Jackie could not reach any engine.",
  );
}
