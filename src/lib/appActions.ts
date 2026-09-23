/**
 * What an agent may do to this app, in one place.
 *
 * Two kinds of agent drive Jackie now: external harnesses (Hermes Agent,
 * DeepSeek Harness) through the MCP server, and agents running inside the app
 * (the Agent Lab's DeepSeek and Hermes presets). They must be able to do
 * exactly the same things with exactly the same rules, or an action that works
 * from one fails from the other for a reason nobody can see. So both call these
 * functions, and each surface only adapts inputs and outputs.
 *
 * Every function takes a Supabase client already carrying the caller's own
 * token, so row-level security is the real boundary, and an explicit
 * `user_id` predicate as well: an agent will call every action with every id it
 * has ever seen, and one mistaken policy edit should be a bug, not a
 * cross-account leak.
 *
 * No Deno globals, no browser globals, no `@/` imports: the MCP plugin bundles
 * this file into a Deno function and the browser imports it directly.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** The values the database's CHECK constraints accept. Anything else is refused there. */
export const TASK_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export const MEMORY_CATEGORIES = ["preference", "decision", "context", "pattern", "architecture", "style"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

// Both branches name both fields: this app's tsconfig is not strict, and without
// strictNullChecks `if (!r.ok)` does not narrow a boolean discriminant.
export type ActionResult<T = unknown> =
  | { ok: true; data: T; error?: undefined }
  | { ok: false; error: string; data?: undefined };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the generated Database type is behind the schema (SECURITY_HARDENING.md)
type Client = SupabaseClient<any, any, any>;

const ok = <T>(data: T): ActionResult<T> => ({ ok: true, data });
const fail = (error: string): ActionResult<never> => ({ ok: false, error });

const TASK_COLUMNS = "id,title,description,status,priority,category,due_date,created_at,updated_at";
const MEMORY_COLUMNS = "id,key,value,category,confidence,updated_at";

function clampLimit(limit: unknown, fallback: number, max = 100): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback;
  return Math.min(Math.max(n, 1), max);
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

/** Strips the characters PostgREST's `or=` filter treats as syntax. */
function filterSafe(text: string): string {
  return text.replace(/[%,()*\\]/g, " ").trim();
}

// ── Tasks ────────────────────────────────────────────────────────────────

export async function listTasks(
  sb: Client,
  userId: string,
  args: { status?: unknown; limit?: unknown },
): Promise<ActionResult> {
  if (args.status !== undefined && !isOneOf(TASK_STATUSES, args.status)) {
    return fail(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  let q = sb
    .from("jackie_tasks")
    .select(TASK_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(clampLimit(args.limit, 25));
  if (args.status) q = q.eq("status", args.status as string);
  const { data, error } = await q;
  return error ? fail(error.message) : ok(data ?? []);
}

export async function createTask(
  sb: Client,
  userId: string,
  args: { title?: unknown; description?: unknown; priority?: unknown; category?: unknown; due_date?: unknown },
): Promise<ActionResult> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return fail("title is required");
  if (args.priority !== undefined && !isOneOf(TASK_PRIORITIES, args.priority)) {
    return fail(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
  }
  const { data, error } = await sb
    .from("jackie_tasks")
    .insert({
      user_id: userId,
      title: title.slice(0, 500),
      description: typeof args.description === "string" ? args.description : null,
      priority: (args.priority as TaskPriority | undefined) ?? "medium",
      category: typeof args.category === "string" ? args.category : null,
      due_date: typeof args.due_date === "string" && args.due_date ? args.due_date : null,
    })
    .select(TASK_COLUMNS);
  return error ? fail(error.message) : ok(data?.[0] ?? null);
}

export async function updateTask(
  sb: Client,
  userId: string,
  args: { id?: unknown; status?: unknown; priority?: unknown; title?: unknown; description?: unknown; due_date?: unknown },
): Promise<ActionResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return fail("id is required");
  const patch: Record<string, unknown> = {};
  if (args.status !== undefined) {
    if (!isOneOf(TASK_STATUSES, args.status)) return fail(`status must be one of: ${TASK_STATUSES.join(", ")}`);
    patch.status = args.status;
  }
  if (args.priority !== undefined) {
    if (!isOneOf(TASK_PRIORITIES, args.priority)) return fail(`priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
    patch.priority = args.priority;
  }
  if (typeof args.title === "string" && args.title.trim()) patch.title = args.title.trim().slice(0, 500);
  if (typeof args.description === "string") patch.description = args.description;
  if (typeof args.due_date === "string") patch.due_date = args.due_date || null;
  if (Object.keys(patch).length === 0) return fail("nothing to change: give status, priority, title, description or due_date");

  const { data, error } = await sb
    .from("jackie_tasks")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId)
    .select(TASK_COLUMNS);
  if (error) return fail(error.message);
  return data?.length ? ok(data[0]) : fail(`No task found with id ${id}`);
}

export async function deleteTask(sb: Client, userId: string, args: { id?: unknown }): Promise<ActionResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return fail("id is required");
  const { data, error } = await sb
    .from("jackie_tasks")
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id,title");
  if (error) return fail(error.message);
  return data?.length ? ok({ deleted: data[0] }) : fail(`No task found with id ${id}`);
}

// ── Memory ───────────────────────────────────────────────────────────────

export async function searchMemory(
  sb: Client,
  userId: string,
  args: { query?: unknown; category?: unknown; limit?: unknown },
): Promise<ActionResult> {
  if (args.category !== undefined && !isOneOf(MEMORY_CATEGORIES, args.category)) {
    return fail(`category must be one of: ${MEMORY_CATEGORIES.join(", ")}`);
  }
  let q = sb
    .from("jackie_memory")
    .select(MEMORY_COLUMNS)
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(clampLimit(args.limit, 25));
  if (args.category) q = q.eq("category", args.category as string);
  const safe = typeof args.query === "string" ? filterSafe(args.query) : "";
  if (safe) q = q.or(`key.ilike.%${safe}%,value.ilike.%${safe}%`);
  const { data, error } = await q;
  return error ? fail(error.message) : ok(data ?? []);
}

/**
 * Stores or overwrites a fact by key.
 *
 * The MCP tool this replaces defaulted the category to "general", which the
 * table's CHECK constraint does not allow — so every call that named no
 * category failed with a constraint error. "context" is the column's own
 * default and what the chat's memory extractor uses.
 */
export async function rememberFact(
  sb: Client,
  userId: string,
  args: { key?: unknown; value?: unknown; category?: unknown },
): Promise<ActionResult> {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const value = typeof args.value === "string" ? args.value.trim() : "";
  if (!key || !value) return fail("key and value are required");
  if (args.category !== undefined && !isOneOf(MEMORY_CATEGORIES, args.category)) {
    return fail(`category must be one of: ${MEMORY_CATEGORIES.join(", ")}`);
  }
  const category = (args.category as MemoryCategory | undefined) ?? undefined;

  const { data: existing, error: findError } = await sb
    .from("jackie_memory")
    .select("id")
    .eq("user_id", userId)
    .eq("key", key)
    .limit(1);
  if (findError) return fail(findError.message);

  const { data, error } = existing?.length
    ? await sb
        .from("jackie_memory")
        .update({ value, ...(category ? { category } : {}) })
        .eq("id", existing[0].id)
        .eq("user_id", userId)
        .select(MEMORY_COLUMNS)
    : await sb
        .from("jackie_memory")
        .insert({ user_id: userId, key, value, category: category ?? "context" })
        .select(MEMORY_COLUMNS);
  return error ? fail(error.message) : ok(data?.[0] ?? null);
}

export async function forgetFact(
  sb: Client,
  userId: string,
  args: { id?: unknown; key?: unknown },
): Promise<ActionResult> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  const key = typeof args.key === "string" ? args.key.trim() : "";
  if (!id && !key) return fail("give the fact's id or key");
  let q = sb.from("jackie_memory").delete().eq("user_id", userId);
  q = id ? q.eq("id", id) : q.eq("key", key);
  const { data, error } = await q.select("id,key");
  if (error) return fail(error.message);
  return data?.length ? ok({ forgotten: data }) : fail(`No memory found with ${id ? `id ${id}` : `key "${key}"`}`);
}

// ── Conversations ────────────────────────────────────────────────────────

export async function listConversations(sb: Client, userId: string, args: { limit?: unknown }): Promise<ActionResult> {
  const { data, error } = await sb
    .from("conversations")
    .select("id,title,model,created_at,updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(clampLimit(args.limit, 20));
  return error ? fail(error.message) : ok(data ?? []);
}

export async function createConversation(sb: Client, userId: string, args: { title?: unknown }): Promise<ActionResult> {
  const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 200) : "Agent session";
  const { data, error } = await sb
    .from("conversations")
    .insert({ user_id: userId, title })
    .select("id,title,created_at");
  return error ? fail(error.message) : ok(data?.[0] ?? null);
}

/** The most recent messages of one conversation, oldest first so they read in order. */
export async function readConversation(
  sb: Client,
  userId: string,
  args: { id?: unknown; limit?: unknown },
): Promise<ActionResult<Array<{ role: string; content: string; created_at: string }>>> {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return fail("id is required");
  const { data, error } = await sb
    .from("chat_messages")
    .select("role,content,created_at")
    .eq("user_id", userId)
    .eq("conversation_id", id)
    .order("created_at", { ascending: false })
    .limit(clampLimit(args.limit, 40, 200));
  if (error) return fail(error.message);
  return ok(((data ?? []) as Array<{ role: string; content: string; created_at: string }>).reverse());
}

export async function saveMessage(
  sb: Client,
  userId: string,
  conversationId: string,
  role: "user" | "assistant",
  content: string,
): Promise<ActionResult> {
  const { error } = await sb
    .from("chat_messages")
    .insert({ user_id: userId, conversation_id: conversationId, role, content });
  if (error) return fail(error.message);
  // Keeps the conversation at the top of the sidebar, where the chat lists by recency.
  await sb.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId).eq("user_id", userId);
  return ok(null);
}

/**
 * The memory-and-tasks block the chat injects into Jackie's system prompt.
 *
 * Same shape as `buildMemoryContext` + `buildTaskContext` in the chat page, so
 * Jackie answers an agent with the same knowledge she answers the owner with.
 */
export async function buildAgentContext(sb: Client, userId: string): Promise<string> {
  const [memories, tasks] = await Promise.all([
    searchMemory(sb, userId, { limit: 60 }),
    listTasks(sb, userId, { limit: 50 }),
  ]);
  let context = "";
  if (memories.ok && Array.isArray(memories.data) && memories.data.length) {
    context += "\n## Jackie's Memory\n";
    for (const m of memories.data as Array<{ key: string; value: string; category: string }>) {
      context += `- **${m.key}** (${m.category}): ${m.value}\n`;
    }
  }
  if (tasks.ok && Array.isArray(tasks.data)) {
    const active = (tasks.data as Array<{ title: string; status: string; priority: string; description?: string | null }>)
      .filter((t) => t.status !== "done");
    if (active.length) {
      context += "\n## Active Tasks\n";
      for (const t of active.slice(0, 15)) {
        context += `- [${t.status}/${t.priority}] **${t.title}**${t.description ? ` — ${t.description.slice(0, 80)}` : ""}\n`;
      }
    }
  }
  return context;
}

/**
 * Reads an OpenAI-compatible SSE body to the end and returns the text.
 *
 * Deliberately as strict as the browser's `streamSse`: an error frame is an
 * error, a stream that carried nothing is an error, and a stream that stopped
 * with neither `[DONE]` nor a finish reason is reported as cut off. An agent
 * handed a half answer as a whole one would act on it.
 */
export async function readSseText(resp: Response): Promise<ActionResult<string>> {
  if (!resp.body) return fail("The response had no body.");
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finished = false;
  const take = (line: string): string | null => {
    if (!line.startsWith("data:")) return null;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      finished = true;
      return null;
    }
    let frame: { error?: { message?: string } | string; choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> };
    try {
      frame = JSON.parse(payload);
    } catch {
      return null;
    }
    if (frame.error) return typeof frame.error === "string" ? frame.error : frame.error.message ?? "stream error";
    const choice = frame.choices?.[0];
    if (typeof choice?.delta?.content === "string") text += choice.delta.content;
    if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
      if (choice.finish_reason === "content_filter") return "The model's content filter stopped the answer.";
      finished = true;
    }
    return null;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const err = take(buffer.slice(0, nl).replace(/\r$/, ""));
      buffer = buffer.slice(nl + 1);
      if (err) return fail(err);
    }
  }
  if (buffer.trim()) {
    const err = take(buffer.trim());
    if (err) return fail(err);
  }
  if (!text.trim()) return fail("Jackie's model returned an empty answer.");
  if (!finished) return fail("The answer was cut off before it finished.");
  return ok(text);
}
