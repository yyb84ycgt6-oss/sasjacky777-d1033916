import { admit, providerFailure } from "../_shared/entitlement.ts";
import { guardedSystemPrompt } from "../_shared/personaGuard.ts";
import { answerBot, BotRequest } from "../_shared/botRuntime.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const MODEL = "google/gemini-3-flash-preview";
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, ...headers, "Content-Type": "application/json" } });
}

// Telegram/Discord IDs never stand in for authentication. A trusted adapter
// still needs an app session; connector webhooks are a separate trust boundary.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const parsed = BotRequest.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return json({ error: "Expected platform and a nonempty message (maximum 16000 characters)." }, 400);
    const key = Deno.env.get("LOVABLE_API_KEY");
    if (!key) return json({ error: "Jackie's bot model is not configured." }, 503);
    const admitted = await admit(req, "jackie-bot", MODEL);
    if (admitted instanceof Response) return admitted;
    let upstreamFailure: Response | undefined;
    const result = await answerBot(parsed.data, {
      prompt: () => guardedSystemPrompt("jackie-bot", { userId: admitted.userId }),
      complete: async (messages) => {
        const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, messages, stream: false }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok) {
          upstreamFailure = await providerFailure("jackie-bot", response);
          throw new Error("The bot's model request failed.");
        }
        const data = await response.json();
        if (data.error) throw new Error("The model reported a failed request.");
        const reply = data.choices?.[0]?.message?.content;
        return typeof reply === "string" ? reply : "";
      },
    }).catch((error) => {
      if (upstreamFailure) return upstreamFailure;
      throw error;
    });
    if (result instanceof Response) return result;
    return json({ reply: result.reply, platform: result.platform }, 200, result.headers);
  } catch (error) {
    // No request content, tokens, or personal history in logs.
    return json({ error: error instanceof Error && error.name === "TimeoutError"
      ? "The bot model timed out. Try again."
      : "Jackie could not complete the bot answer. Try again or check the model connection." }, 502);
  }
});