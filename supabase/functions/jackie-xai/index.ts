// Streaming chat via xAI Grok direct (paid; OpenAI-compatible).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { gate } from "../_shared/entitlement.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ALLOWED = new Set([
  "grok-4.5",
  "grok-4-latest",
  "grok-3",
  "grok-3-mini",
  "grok-2-latest",
  "grok-2-vision-latest",
  "grok-beta",
]);
const DEFAULT_MODEL = "grok-4.5";
const SECRET = "XAI_API_KEY";
const BASE = "https://api.x.ai/v1/chat/completions";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const un = await gate(req, "jackie-xai");
  if (un) return un;

  const key = Deno.env.get(SECRET);
  if (!key) {
    return new Response(JSON.stringify({
      error: `${SECRET} not configured. Paste your xAI key at https://console.x.ai/`,
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
      return new Response(JSON.stringify({ error: `xAI ${resp.status}: ${text}` }), {
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
