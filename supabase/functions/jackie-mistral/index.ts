// Streaming chat via Mistral La Plateforme (free experimental tier).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED = new Set([
  "mistral-large-latest",
  "mistral-small-latest",
  "open-mistral-nemo",
  "codestral-latest",
  "pixtral-large-latest",
]);
const DEFAULT_MODEL = "mistral-small-latest";
const SECRET = "MISTRAL_API_KEY";
const BASE = "https://api.mistral.ai/v1/chat/completions";

async function requireUser(req: Request): Promise<Response | null> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await sb.auth.getClaims(auth.replace("Bearer ", ""));
  if (error || !data?.claims) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const un = await requireUser(req);
  if (un) return un;

  const key = Deno.env.get(SECRET);
  if (!key) {
    return new Response(JSON.stringify({
      error: `${SECRET} not configured. Get a free key at https://console.mistral.ai/api-keys/`,
      needs_secret: SECRET,
    }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const { messages, model, system } = await req.json();
    const selected = ALLOWED.has(model) ? model : DEFAULT_MODEL;
    const body = {
      model: selected,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        ...messages,
      ],
      stream: true,
    };
    const resp = await fetch(BASE, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return new Response(JSON.stringify({ error: `Mistral ${resp.status}: ${text}` }), {
        status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(resp.body, { headers: { ...corsHeaders, "Content-Type": "text/event-stream" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
