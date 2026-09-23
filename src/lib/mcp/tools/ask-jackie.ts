// Talks to Jackie the way the chat page does, and leaves the exchange in the app.
//
// The other tools let a harness read and change Jackie's data; this one lets it
// hold a conversation with her. It goes through the same edge functions the
// chat uses, with the caller's own token, so every rule the chat obeys applies
// here too: the model allowlist, the quota, the owner-only engines. The
// question and the answer are saved to a conversation, so whatever an agent
// does is visible in the sidebar afterwards rather than happening off-screen.
import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, supabaseProjectUrl, supabasePublishableKey } from "../supabase";
import {
  buildAgentContext, createConversation, readConversation, readSseText, saveMessage,
} from "../../appActions";
import { notAuthenticated } from "../result";

/** The chat's streaming engines, by the function that serves each. */
export const ASK_ENGINES = {
  cloud: "jackie-chat",
  deepseek: "jackie-deepseek",
  bionic: "jackie-bionic",
  ollama: "jackie-ollama",
} as const;

const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export default defineTool({
  name: "ask_jackie",
  title: "Ask Jackie",
  description:
    "Send a message to Jackie and get her answer. She sees the user's memory and active tasks. " +
    "The exchange is saved to a conversation in the app (a new one unless conversation_id is given).",
  inputSchema: {
    message: z.string().trim().min(1).max(20_000).describe("What to say to Jackie."),
    conversation_id: z.string().trim().optional().describe("Continue this conversation (its recent history is sent)."),
    title: z.string().optional().describe("Title for a new conversation."),
    engine: z
      .enum(["cloud", "deepseek", "bionic", "ollama"])
      .optional()
      .describe("Which engine answers (default cloud). bionic and ollama answer the owner only."),
    model: z.string().optional().describe("Model id for that engine; omit for its default."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async ({ message, conversation_id, title, engine, model }, ctx) => {
    if (!ctx.isAuthenticated()) return notAuthenticated;
    const token = ctx.getToken();
    if (!token) return notAuthenticated;
    const sb = supabaseForUser(ctx);
    const userId = ctx.getUserId();

    let conversationId = conversation_id;
    let history: Array<{ role: "user" | "assistant"; content: string }> = [];
    if (conversationId) {
      const past = await readConversation(sb, userId, { id: conversationId, limit: 20 });
      if (!past.ok) return fail(past.error);
      history = past.data
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
    } else {
      const created = await createConversation(sb, userId, { title: title ?? message.slice(0, 60) });
      if (!created.ok) return fail(created.error);
      conversationId = (created.data as { id: string }).id;
    }

    const fn = ASK_ENGINES[engine ?? "cloud"];
    const context = await buildAgentContext(sb, userId);

    let resp: Response;
    try {
      resp = await fetch(`${supabaseProjectUrl()}/functions/v1/${fn}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabasePublishableKey(),
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: [...history, { role: "user", content: message }],
          ...(model ? { model } : {}),
          ...(context ? { context } : {}),
        }),
      });
    } catch (e) {
      return fail(`Could not reach ${fn}: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!resp.ok) {
      const body = (await resp.json().catch(() => null)) as { error?: string; detail?: string } | null;
      const why = [body?.error, body?.detail].filter(Boolean).join(" ") || `HTTP ${resp.status}`;
      return fail(`${fn} refused: ${why}`);
    }

    const answer = await readSseText(resp);
    if (!answer.ok) return fail(`${fn}: ${answer.error}`);

    // Saved only once there is an answer, so a failed ask leaves no orphaned
    // question in the conversation for the next ask to carry as history.
    const savedQ = await saveMessage(sb, userId, conversationId!, "user", message);
    const savedA = savedQ.ok ? await saveMessage(sb, userId, conversationId!, "assistant", answer.data) : savedQ;
    const result = {
      conversation_id: conversationId,
      engine: engine ?? "cloud",
      answer: answer.data,
      ...(savedA.ok ? {} : { warning: `Answered, but not saved to the conversation: ${savedA.error}` }),
    };
    return {
      content: [{ type: "text" as const, text: answer.data }],
      structuredContent: result,
    };
  },
});
