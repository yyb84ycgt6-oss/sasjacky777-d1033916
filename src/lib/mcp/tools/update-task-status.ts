import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser } from "../supabase";

export default defineTool({
  name: "update_task_status",
  title: "Update task status",
  description: "Change the status of one of the signed-in user's Jackie tasks.",
  inputSchema: {
    id: z.string().trim().min(1).describe("Task id (uuid)."),
    status: z.string().trim().min(1).describe("New status, e.g. pending, in_progress, done."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  handler: async ({ id, status }, ctx) => {
    if (!ctx.isAuthenticated()) {
      return { content: [{ type: "text", text: "Not authenticated" }], isError: true };
    }
    const supabase = supabaseForUser(ctx);
    const { data, error } = await supabase
      .from("jackie_tasks")
      .update({ status })
      .eq("id", id)
      .select("id,title,status,priority,updated_at");
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    if (!data?.length) {
      return { content: [{ type: "text", text: `No task found with id ${id}` }], isError: true };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(data[0]) }],
      structuredContent: { task: data[0] },
    };
  },
});
