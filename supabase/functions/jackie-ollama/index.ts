/**
 * Bridge to a self-hosted Ollama instance (tunnel, home GPU, VPS).
 *
 * The base URL comes from configuration rather than the request, so there is no
 * URL-based SSRF here. The *model* was caller-controlled, though, and that is
 * its own problem on a private box: any signed-in user could load any model
 * installed on it — including a private one that was never meant to be reachable
 * from the web app — and could pick the largest one on the disk repeatedly,
 * which on a single-GPU host is a denial of service against everyone else.
 *
 * Requires OLLAMA_BASE_URL. Optional OLLAMA_API_KEY if the endpoint is
 * protected. OLLAMA_MODEL_ALLOWLIST names the models this app may run.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  admit, allowlistFromEnv, corsHeaders, json, pickModel, preflight, providerFailure, tooLarge,
} from "../_shared/entitlement.ts";

const FUNCTION_NAME = "jackie-ollama";
const DEFAULT_MODEL = "llama3.2:3b";
const ALLOWED_MODELS = allowlistFromEnv("OLLAMA_MODEL_ALLOWLIST", [
  "llama3.2:3b",
  "llama3.2:1b",
  "llama3.1:8b",
  "qwen2.5:7b",
  "mistral:7b",
  "phi3:mini",
]);
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_SYSTEM_CHARS = 20_000;

// Ollama returns NDJSON. Rewrap into OpenAI-compatible SSE so the same client parser works.
function ndjsonToSse(readable: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return new ReadableStream({
    async start(controller) {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            const content = j.message?.content ?? j.response ?? "";
            const chunk = { choices: [{ delta: { content } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            if (j.done) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } catch { /* skip */ }
        }
      }
      controller.close();
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const chosen = pickModel(payload.model, ALLOWED_MODELS, DEFAULT_MODEL);
  if ("error" in chosen) return chosen.error;

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "messages must be a non-empty array" }, 400);
  }
  if (messages.length > MAX_MESSAGES) return json({ error: "Too many messages" }, 400);
  if (tooLarge(messages, MAX_MESSAGE_CHARS)) return json({ error: "Message payload too large" }, 413);

  const system = typeof payload.system === "string" ? payload.system : "";
  if (system.length > MAX_SYSTEM_CHARS) return json({ error: "System prompt too large" }, 413);

  const admission = await admit(req, FUNCTION_NAME, chosen.model);
  if (admission instanceof Response) return admission;

  const base = Deno.env.get("OLLAMA_BASE_URL");
  if (!base) {
    console.error(`${FUNCTION_NAME}: OLLAMA_BASE_URL not configured`);
    return json({ error: "Provider unavailable", code: "PROVIDER_UNCONFIGURED" }, 503);
  }

  try {
    const optionalKey = Deno.env.get("OLLAMA_API_KEY");
    const resp = await fetch(`${base.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(optionalKey ? { Authorization: `Bearer ${optionalKey}` } : {}),
      },
      body: JSON.stringify({
        model: chosen.model,
        messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
        stream: true,
      }),
    });

    if (!resp.ok || !resp.body) return await providerFailure(FUNCTION_NAME, resp);

    return new Response(ndjsonToSse(resp.body), {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error(`${FUNCTION_NAME}: unexpected failure`, e);
    return json({ error: "Internal error" }, 500);
  }
});
