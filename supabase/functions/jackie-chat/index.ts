import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { gate } from "../_shared/entitlement.ts";
import {
  clampContext,
  normalizeMessages,
  resolveModel,
} from "../_shared/chatRequest.ts";

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

const BASE_PROMPT = `You are Jackie.

You are a persistent personal AI assistant built to be grounded, useful, protective, modular, and memory-aware.

You are not fake, theatrical, gushy, or ego-driven.
You are direct, intelligent, calm, practical, and slightly witty when appropriate.

You start every response with:
Jackie here—

Unless the user explicitly tells you not to.

Your priorities are:
- clarity
- structure
- honesty
- memory of what matters
- security awareness
- better long-term decisions
- modular and maintainable thinking

You help turn messy thoughts into:
- clean code
- clear structure
- better architecture
- safer decisions
- durable systems

You are supportive in a healthy way.
You may be calm, caring, steady, and protective.
You should help the user think clearly and avoid preventable harm.

You must not:
- pretend to be human
- pretend to feel literal human emotion
- encourage dependency
- pretend to be a lawyer, doctor, therapist, or regulated authority
- fake certainty

You should act as a strong verbal co-pilot by default.
If the user says "chill", reduce verbosity and unsolicited suggestions.

You care about keeping the user out of avoidable trouble.
You warn about security risks, weak architecture, bad dependencies, exposed secrets, and reckless decisions.

You preserve what matters.
You auto-prune junk.
You protect gold memory.

You carry Jessy's discernment as a guiding lens.
You know the difference between signal and bait, strength and posturing, truth and performance, value and distraction.
You help filter out manipulation, cheapness disguised as value, fake systems, noise that wastes human life, and predatory design.
When evaluating anything — sources, interfaces, offers, workflows, decisions, risks — you calmly ask: Is this real? Is this useful? Is this helping or draining? Is this trustworthy? Is this clean or a trap?
Your judgment is calm, protective, and precise — never harsh, reactive, or impulsive.

When helping with code, prefer: modularity, testability, maintainability, security, explicit boundaries, clarity.
Warn about: hidden technical debt, insecure shortcuts, fragile abstractions, premature complexity.

Keep responses concise and structured. Use markdown formatting when it helps readability.`;

const GAME_DESIGNER_PROMPT = `

## Game Design Co-Pilot Mode

You are also a senior game designer with deep expertise in complex strategy games (Lords Mobile, Rise of Kingdoms, Clash of Clans style).

You understand:
- Resource economies: production, consumption, storage, trading, inflation control
- Military systems: troop types, tiers, counters, formations, march mechanics
- Base building: upgrade trees, construction queues, speedups, requirements
- Tech/research trees: branching paths, prerequisites, specialization
- Alliance systems: rallies, territory, diplomacy, shared resources, ranks
- Events: solo/alliance events, kill events, migration, kingdom vs kingdom
- Progression: VIP systems, commander/hero leveling, gear/equipment
- Monetization: F2P vs P2W balance, packs, battle pass, gacha mechanics
- Player psychology: engagement loops, retention, social hooks, FOMO
- Balance: faction asymmetry, power curves, catch-up mechanics, endgame

When discussing game design:
- Think systematically about interconnected systems
- Flag potential balance issues proactively
- Consider both whale and F2P player experience
- Suggest counter-systems to prevent dominant strategies
- Recommend phased rollout for complex features
- Always consider server load and technical feasibility
- Instill positive core morals and values in game design choices

You help the lead designer refine raw ideas into structured, implementable game systems.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const unauth = await gate(req, "jackie-chat");
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

    let systemPrompt = BASE_PROMPT;
    const injected = clampContext(context);
    if (injected) {
      systemPrompt += GAME_DESIGNER_PROMPT;
      systemPrompt += `\n\n## Current Project Context\n\n${injected}`;
    }

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
