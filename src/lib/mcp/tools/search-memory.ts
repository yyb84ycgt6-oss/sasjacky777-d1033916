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
