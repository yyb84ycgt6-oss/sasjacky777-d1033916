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
  name: "list_conversations",
  title: "List conversations",
  description: "List the signed-in user's Jackie chat conversations, most recently updated first.",
  inputSchema: {
    limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 20)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("conversations")
      .select("id,title,model,created_at,updated_at")
      .eq("user_id", ctx.getUserId())
      .order("updated_at", { ascending: false })
      .limit(limit ?? 20);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { conversations: data ?? [] },
    };
  },
});
