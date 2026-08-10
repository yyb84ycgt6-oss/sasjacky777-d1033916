import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "create_task",
  title: "Create task",
  description: "Create a new Jackie task for the signed-in user.",
  inputSchema: {
    title: z.string().trim().min(1).describe("Short task title."),
    description: z.string().optional().describe("Optional longer detail."),
    priority: z.string().optional().describe("Priority, e.g. low, medium, high."),
    category: z.string().optional().describe("Optional grouping category."),
    due_date: z.string().optional().describe("Optional ISO 8601 due date."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: async ({ title, description, priority, category, due_date }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("jackie_tasks")
      .insert({
        user_id: ctx.getUserId(),
        title,
        description: description ?? null,
        priority: priority ?? "medium",
        category: category ?? null,
        due_date: due_date ?? null,
      })
      .select("id,title,status,priority,category,due_date,created_at");
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data?.[0] ?? null) }],
      structuredContent: { task: data?.[0] ?? null },
    };
  },
});
