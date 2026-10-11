/**
 * The /skills page's data: the person writing, approving and reviewing what
 * their agents use.
 *
 * Agents go through appActions.ts and can only propose. Here the person is
 * acting for themselves, from the app's own session, so they can write active
 * skills and tools, approve proposals and archive or delete — the database's
 * agent rule does not apply to a session with no OAuth client behind it.
 */
import { supabase } from "@/integrations/supabase/client";
import { runCustomTool, type ActionResult } from "@/lib/appActions";
import {
  validateSkill, validateToolSpec, type SkillSpec, type ToolParam, type ToolSpec, type ToolStep,
} from "@/lib/customTools";

export type Status = "proposed" | "active" | "archived";

export interface SkillRow extends SkillSpec {
  id: string;
  status: Status;
  proposed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ToolRow extends ToolSpec {
  id: string;
  status: Status;
  proposed_by: string | null;
  params: ToolParam[];
  steps: ToolStep[];
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: string;
  ts: string;
  action: string;
  actor: string;
  details: Record<string, unknown> | null;
  result: "success" | "denied" | "error";
}

// The new tables are not in the generated types until they are regenerated
// after `supabase db push`; the same cast the other owner pages use.
type Loose = { from: (t: string) => any };
const db = supabase as unknown as Loose;

async function me(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

async function run<T>(q: () => any): Promise<ActionResult<T>> {
  try {
    const { data, error } = await q();
    if (error) return { ok: false, error: friendly(error.message ?? String(error)) };
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function friendly(message: string): string {
  if (/duplicate key|unique/i.test(message)) return "That name is already taken by another skill or tool of yours.";
  if (/relation .* does not exist|schema cache|PGRST205/i.test(message)) {
    return "The skills tables are not in the database yet. Run `supabase db push`, then reload.";
  }
  return message;
}

export const loadSkills = () =>
  run<SkillRow[]>(() => db.from("jackie_skills").select("*").order("status").order("name"));
export const loadTools = () =>
  run<ToolRow[]>(() => db.from("jackie_custom_tools").select("*").order("status").order("name"));

/** What agents did with skills and tools, newest first, from the person's own audit trail. */
export const loadActivity = () =>
  run<ActivityRow[]>(() =>
    db.from("audit_events")
      .select("id,ts,action,actor,details,result")
      .or("action.like.skill.%,action.like.tool.%")
      .order("ts", { ascending: false })
      .limit(50));

export async function saveSkill(spec: SkillSpec, id?: string): Promise<ActionResult<null>> {
  const problem = validateSkill(spec);
  if (problem) return { ok: false, error: problem };
  const row = { name: spec.name, title: spec.title.trim(), description: spec.description.trim(), body: spec.body.trim() };
  if (id) return run(() => db.from("jackie_skills").update(row).eq("id", id));
  const userId = await me();
  if (!userId) return { ok: false, error: "You are signed out. Sign in and try again." };
  return run(() => db.from("jackie_skills").insert({ ...row, user_id: userId, status: "active" }));
}

export async function saveTool(spec: ToolSpec, id?: string): Promise<ActionResult<null>> {
  const problem = validateToolSpec(spec);
  if (problem) return { ok: false, error: problem };
  const row = { name: spec.name, description: spec.description.trim(), params: spec.params, steps: spec.steps };
  if (id) return run(() => db.from("jackie_custom_tools").update(row).eq("id", id));
  const userId = await me();
  if (!userId) return { ok: false, error: "You are signed out. Sign in and try again." };
  return run(() => db.from("jackie_custom_tools").insert({ ...row, user_id: userId, status: "active" }));
}

export const setStatus = (table: "jackie_skills" | "jackie_custom_tools", id: string, status: Status) =>
  run<null>(() => db.from(table).update({ status }).eq("id", id));

export const remove = (table: "jackie_skills" | "jackie_custom_tools", id: string) =>
  run<null>(() => db.from(table).delete().eq("id", id));

/** Runs a tool now, as the person — the same runner agents use, so a test here is a real test. */
export async function runToolNow(name: string, args: Record<string, unknown>): Promise<ActionResult> {
  const userId = await me();
  if (!userId) return { ok: false, error: "You are signed out. Sign in and try again." };
  return runCustomTool(supabase, userId, { name, args }, { via: "app", allowDestructive: true });
}
