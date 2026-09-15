/**
 * Bionic — the chat's first local fallback.
 *
 * BionicGPT does not host weights of its own; it serves whatever GGUF the
 * operator has loaded over an OpenAI-compatible port (see
 * `src/lib/repair/modelBridge.ts`, which sets that up). So this function is a
 * thin, authenticated bridge to that port: same request shape as
 * `jackie-chat`, same SSE out, same persona in — which is the point. The router
 * can hand this function a conversation the cloud gateway refused and get an
 * answer back in the same format, from the operator's own hardware.
 *
 * Anything speaking the OpenAI chat-completions API works here: BionicGPT,
 * LM Studio, llama.cpp's server, vLLM, Jan. Set:
 *
 *   BIONIC_BASE_URL   e.g. https://bionic.mydomain.com  (a /v1 suffix is
 *                     optional — it is added when missing)
 *   BIONIC_API_KEY    optional, when the endpoint is protected
 *   BIONIC_MODEL      optional default model name, e.g. bonsai-1.7b
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.58.0";
import { bearerToken, verifyAccessToken } from "../_shared/authGate.ts";
import { clampContext, normalizeMessages } from "../_shared/chatRequest.ts";
import { buildSystemPrompt } from "../_shared/persona.ts";
import { bionicEndpoint } from "../_shared/bionicEndpoint.ts";

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

/** Same gate as `jackie-chat`: it returns a verdict and never throws. */
async function requireUser(req: Request): Promise<Response | null> {
  const token = bearerToken(req.headers.get("Authorization"));
  if (!token) return json({ error: "Unauthorized", detail: "Sign in and try again." }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const anon =
    Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anon) {
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
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const unauth = await requireUser(req);
    if (unauth) return unauth;

    const payload = await req.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return json({ error: "Expected a JSON body" }, 400);
    }
    const { messages, model, context, system } = payload as {
      messages?: unknown;
      model?: unknown;
      context?: unknown;
      system?: unknown;
    };

    const verdict = normalizeMessages(messages);
    if (!verdict.ok) return json({ error: verdict.reason }, 400);

    const baseUrl = Deno.env.get("BIONIC_BASE_URL");
    if (!baseUrl) {
      // `needs_secret` is what tells the router this engine is not configured
      // rather than broken, so it moves on without making noise about it.
      return json(
        {
          error:
            "Bionic is not connected. Set BIONIC_BASE_URL to your OpenAI-compatible endpoint (BionicGPT, LM Studio, llama.cpp, vLLM).",
          needs_secret: "BIONIC_BASE_URL",
        },
        503,
      );
    }

    const selected =
      typeof model === "string" && model.trim()
        ? model.trim()
        : Deno.env.get("BIONIC_MODEL") || "bonsai-1.7b";

    const systemPrompt =
      typeof system === "string" && system.trim()
        ? system.trim()
        : buildSystemPrompt(clampContext(context));

    const apiKey = Deno.env.get("BIONIC_API_KEY");

    // A local server that accepts the connection and then thinks forever is the
    // common failure on an under-specced box. Bound the wait for headers only —
    // a slow first token is still an answer, a silent socket is not.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);

    let upstream: Response;
    try {
      upstream = await fetch(bionicEndpoint(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: selected,
          messages: [{ role: "system", content: systemPrompt }, ...verdict.messages],
          stream: true,
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      return json(
        {
          error: aborted
            ? "Bionic did not answer in time."
            : "Could not reach the Bionic endpoint.",
          detail: String((e as Error)?.message || e),
        },
        504,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      return json(
        {
          error: `Bionic refused the request (HTTP ${upstream.status}).`,
          detail: text.slice(0, 500) || undefined,
          model: selected,
        },
        upstream.status && upstream.status >= 400 && upstream.status < 500 ? 502 : upstream.status || 502,
      );
    }

    return new Response(upstream.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});
