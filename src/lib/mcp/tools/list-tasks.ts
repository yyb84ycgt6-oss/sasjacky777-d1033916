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
  name: "list_tasks",
  title: "List tasks",
  description: "List the signed-in user's Jackie tasks, newest first. Optionally filter by status.",
  inputSchema: {
    status: z.string().optional().describe("Filter by task status, e.g. pending, in_progress, done."),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 25)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ status, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let query = supabase
      .from("jackie_tasks")
      .select("id,title,description,status,priority,category,due_date,created_at")
      .eq("user_id", ctx.getUserId())
      .order("created_at", { ascending: false })
      .limit(limit ?? 25);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { tasks: data ?? [] },
    };
  },
});
