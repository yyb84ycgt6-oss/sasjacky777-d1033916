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
  name: "search_memory",
  title: "Search Jackie memory",
  description: "Search the signed-in user's Jackie long-term memory entries by key or value text.",
  inputSchema: {
    query: z.string().trim().optional().describe("Text to match against memory key or value. Omit to list recent entries."),
    category: z.string().optional().describe("Optional category filter."),
    limit: z.number().int().min(1).max(100).optional().describe("Max rows to return (default 25)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ query, category, limit }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    let q = supabase
      .from("jackie_memory")
      .select("id,key,value,category,confidence,updated_at")
      .eq("user_id", ctx.getUserId())
      .order("updated_at", { ascending: false })
      .limit(limit ?? 25);
    if (category) q = q.eq("category", category);
    if (query) {
      const safe = query.replace(/[%,()]/g, " ").trim();
      if (safe) q = q.or(`key.ilike.%${safe}%,value.ilike.%${safe}%`);
    }
    const { data, error } = await q;
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { entries: data ?? [] },
    };
  },
});
