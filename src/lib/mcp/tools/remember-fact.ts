// Owner-scoped by RLS *and* by an explicit predicate.
//
// This client is built with the caller's token and the publishable key, so RLS
// is the real security boundary and it is correct today. The extra
// `.eq("user_id", ...)` is not redundant defence-in-depth theatre: it is the
// difference between one mistaken policy edit being a bug and being a
// cross-account data leak. An MCP endpoint is exactly where that matters,
// because the client on the other end is an agent that will call every tool
// with every id it has seen.
import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "remember_fact",
  title: "Remember a fact",
  description: "Store or overwrite a fact in the signed-in user's Jackie long-term memory.",
  inputSchema: {
    key: z.string().trim().min(1).describe("Stable identifier for the fact."),
    value: z.string().trim().min(1).describe("The fact to remember."),
    category: z.string().optional().describe("Optional category, e.g. preference, project, constraint."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ key, value, category }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const userId = ctx.getUserId();
    const { data: existing, error: findError } = await supabase
      .from("jackie_memory")
      .select("id")
      .eq("user_id", userId)
      .eq("key", key)
      .limit(1);
    if (findError) return { content: [{ type: "text", text: findError.message }], isError: true };

    const { data, error } = existing?.length
      ? await supabase
          .from("jackie_memory")
          .update({ value, ...(category ? { category } : {}) })
          .eq("id", existing[0].id)
          .eq("user_id", userId)
          .select("id,key,value,category,updated_at")
      : await supabase
          .from("jackie_memory")
          .insert({ user_id: userId, key, value, category: category ?? "general" })
          .select("id,key,value,category,updated_at");

    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data?.[0] ?? null) }],
      structuredContent: { entry: data?.[0] ?? null },
    };
  },
});
