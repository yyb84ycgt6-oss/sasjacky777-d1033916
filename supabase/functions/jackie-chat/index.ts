import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import { bearerToken, verifyAccessToken } from "../_shared/authGate.ts";
import {
  clampContext,
  normalizeMessages,
  resolveModel,
} from "../_shared/chatRequest.ts";
import { buildSystemPrompt } from "../_shared/persona.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * The auth gate.
 *
 * Two things here are load-bearing and were not before.
 *
 * It cannot throw. The previous gate called `auth.getClaims`, which does not
 * exist in the supabase-js version this function pinned, so every request died
 * with a TypeError *in the gate* — which sits ahead of the request's
 * try/catch. The isolate answered 500 with no CORS headers, the browser was
 * not allowed to read that, and the chat showed "Failed to fetch". A gate that
 * returns a verdict instead of throwing cannot take the function down with it,
 * and `verifyAccessToken` is built not to throw.
 *
 * And it answers with CORS headers on every path, including the failures. A
 * 401 the browser cannot read is indistinguishable from the server being down.
 */
async function requireUser(req: Request): Promise<Response | null> {
  const token = bearerToken(req.headers.get("Authorization"));
  if (!token) return json({ error: "Unauthorized", detail: "Sign in and try again." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  // Projects created before and after the API-key change expose different
  // names for the same public key. Reading both means the gate does not depend
  // on which era this project was created in.
  const anon =
    Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anon) {
    console.error("auth gate misconfigured: SUPABASE_URL / SUPABASE_ANON_KEY missing");
    return json(
      {
        error: "Server auth is not configured",
        detail: "SUPABASE_URL and SUPABASE_ANON_KEY must be set on this function.",
      },
      503,
    );
  }

  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data, error } = await verifyAccessToken(supabase.auth, token);
  if (error || !data?.claims) {
    return json({ error: "Unauthorized", detail: "Your session expired. Sign in again." }, 401);
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const unauth = await requireUser(req);
    if (unauth) return unauth;

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return json({ error: "Expected a JSON body" }, 400);
    }
    const { messages, model, context } = payload as {
      messages?: unknown;
      model?: unknown;
      context?: unknown;
    };

    const verdict = normalizeMessages(messages);
    if (!verdict.ok) return json({ error: verdict.reason }, 400);

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) {
      // Named plainly, because this is the one failure the owner can fix in a
      // minute and the one the old code reported as "Unknown error".
      return json(
        {
          error: "Jackie has no model key",
          detail: "Set the LOVABLE_API_KEY secret on this project, then try again.",
        },
        503,
      );
    }

    const { model: selectedModel } = resolveModel(model);
    // GPT-5.6 on chat completions runs with reasoning on by default and rejects
    // tool-bearing requests unless effort is explicitly disabled.
    const extraFields = selectedModel.startsWith("openai/gpt-5.6")
      ? { reasoning_effort: "none" }
      : {};

    const systemPrompt = buildSystemPrompt(clampContext(context));

    // A gateway that accepts the connection and then never answers leaves the
    // browser holding an open stream with no content, which reads as "Jackie is
    // thinking" and never resolves. This bounds the wait for the *headers*
    // only, and is cleared the moment they arrive — a long answer that streams
    // for three minutes is working, and cutting it off at a deadline would be
    // the same silent truncation from the other direction.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    let response: Response;
    try {
      response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          ...extraFields,
          messages: [{ role: "system", content: systemPrompt }, ...verdict.messages],
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      console.error("AI gateway unreachable:", e);
      return json(
        {
          error: aborted
            ? "The model took too long to answer. Try again, or pick a faster model."
            : "Could not reach the model gateway.",
          detail: String((e as Error)?.message || e),
        },
        504,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error("AI gateway error:", response.status, text);

      if (response.status === 429) {
        return json({ error: "Rate limit exceeded. Please wait a moment and try again." }, 429);
      }
      if (response.status === 402) {
        return json({ error: "Usage limit reached. Please add credits to your workspace." }, 402);
      }
      if (response.status === 401 || response.status === 403) {
        return json(
          {
            error: "Jackie's model key was refused.",
            detail: "Check the LOVABLE_API_KEY secret on this project.",
          },
          502,
        );
      }
      // Everything else forwards the gateway's own words. "AI gateway error"
      // with the cause swallowed into a server log is not something the person
      // looking at the screen can do anything with.
      return json(
        {
          error: `The model gateway refused the request (HTTP ${response.status}).`,
          detail: text.slice(0, 500) || undefined,
          model: selectedModel,
        },
        502,
      );
    }

    if (!response.body) {
      return json({ error: "The model gateway returned an empty response." }, 502);
    }

    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        // Streaming through a proxy that buffers turns a live answer into a
        // long silence followed by everything at once.
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    console.error("chat error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
