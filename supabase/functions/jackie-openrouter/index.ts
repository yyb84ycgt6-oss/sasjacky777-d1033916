/**
 * Streaming chat via OpenRouter.
 *
 * The previous version said, in a comment, "Any model id from openrouter.ai is
 * accepted, but we prefer known free ids" — and meant it: the free-model set
 * was consulted only to decorate an error message, while any non-empty caller
 * string went upstream on the project's OPENROUTER_API_KEY. OpenRouter bills
 * per model, so that made "which of our paid models would you like us to buy
 * for you" a parameter of the API, available to anyone who could sign up.
 *
 * The set is now the allowlist, and unknown models are refused before the key
 * is touched.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  admit, allowlistFromEnv, corsHeaders, json, pickModel, preflight,
  providerFailure, tooLarge,
} from "../_shared/entitlement.ts";

const FUNCTION_NAME = "jackie-openrouter";
const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

// Free tiers move. The list is overridable without a redeploy so an operator
// can drop a model that starts charging, or add one that stops.
const ALLOWED_MODELS = allowlistFromEnv("OPENROUTER_MODEL_ALLOWLIST", [
  "meta-llama/llama-3.3-70b-instruct:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "meta-llama/llama-3.2-1b-instruct:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "meta-llama/llama-3.1-405b-instruct:free",
  "meta-llama/llama-4-scout:free",
  "meta-llama/llama-4-maverick:free",
  "google/gemma-3-27b-it:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "qwen/qwen-2.5-72b-instruct:free",
  "qwen/qwen-2.5-coder-32b-instruct:free",
  "deepseek/deepseek-r1:free",
  "deepseek/deepseek-chat:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "microsoft/phi-3-mini-128k-instruct:free",
]);

const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 100_000;
const MAX_SYSTEM_CHARS = 20_000;

serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  // Shape first, then spend. Validating before admission means a malformed
  // request does not cost the caller a slice of their quota.
  const chosen = pickModel(payload.model, ALLOWED_MODELS, DEFAULT_MODEL);
  if ("error" in chosen) return chosen.error;

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "messages must be a non-empty array" }, 400);
  }
  if (messages.length > MAX_MESSAGES) return json({ error: "Too many messages" }, 400);
  if (tooLarge(messages, MAX_MESSAGE_CHARS)) {
    return json({ error: "Message payload too large" }, 413);
  }

  const system = typeof payload.system === "string" ? payload.system : "";
  if (system.length > MAX_SYSTEM_CHARS) return json({ error: "System prompt too large" }, 413);

  const admission = await admit(req, FUNCTION_NAME, chosen.model);
  if (admission instanceof Response) return admission;

  const key = Deno.env.get("OPENROUTER_API_KEY");
  if (!key) {
    console.error(`${FUNCTION_NAME}: OPENROUTER_API_KEY not configured`);
    return json({ error: "Provider unavailable", code: "PROVIDER_UNCONFIGURED" }, 503);
  }

  try {
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://jecodedesjeux2026.lovable.app",
        "X-Title": "Jackie",
      },
      body: JSON.stringify({
        model: chosen.model,
        messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
        stream: true,
      }),
    });

    if (!resp.ok) return await providerFailure(FUNCTION_NAME, resp);

    return new Response(resp.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error(`${FUNCTION_NAME}: unexpected failure`, e);
    return json({ error: "Internal error" }, 500);
  }
});
