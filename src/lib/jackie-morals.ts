/**
 * Jackie's morals and the guard rail around them, on the browser side.
 *
 * What lives where, and why:
 *  - The morals themselves are rows in `jackie_morals`, owner-only by RLS. The
 *    engines read them server-side; nothing here sends them to an engine.
 *  - Every change is chained into `jackie_morals_ledger` by a database trigger.
 *    This file re-verifies that chain from scratch on every check, because a
 *    verification the server did on its own behalf proves nothing to the owner.
 *  - The browser keeps a witness: the last ledger head it verified. A history
 *    that no longer contains it was rewritten, however well the new chain
 *    verifies on its own.
 *  - `assessIntegrity` turns all of it into the checks the page shows. It is
 *    pure, so every verdict the owner might see is covered by a test.
 *
 * Agents get none of this. No MCP tool and no in-app operator action reads or
 * writes the morals (a test enforces it): an agent able to edit the rules that
 * bind it would make them suggestions.
 */
import { supabase } from "@/integrations/supabase/client";
import { callEdgeFunction, describeEdgeFailure } from "@/lib/edgeFunction";
import {
  buildMoralsBlock, MORAL_CATEGORIES, MORAL_LIMITS, PERSONA_ENGINES,
  type Moral, type MoralCategory,
} from "../../supabase/functions/_shared/morals";

export { buildMoralsBlock, MORAL_CATEGORIES, MORAL_LIMITS, PERSONA_ENGINES };
export type { Moral, MoralCategory };

// --- types ---------------------------------------------------------------------

export interface MoralRow extends Moral {
  id: string;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  seq: number;
  at: string;
  actor: string | null;
  action: "create" | "update" | "delete" | "seal";
  moral_id: string | null;
  payload: string;
  prev_hash: string;
  hash: string;
}

export interface AttestationRow {
  engine: string;
  mode: "persona" | "persona-without-morals" | "override";
  persona_fp: string;
  morals_fp: string;
  detail: string | null;
  first_seen: string;
  last_seen: string;
  requests: number;
}

export interface PersonaStatus {
  persona: { text: string; fingerprint: string };
  morals: { block: string; fingerprint: string; count: number; enabled: number; error?: string };
  engines: string[];
}

/** What a seal entry's payload holds. Written by the jackie-morals function. */
export interface SealRecord {
  seq: number;
  at: string;
  actor: string | null;
  persona_fp: string;
  persona_text: string;
  morals_fp: string;
  morals_block: string;
  note?: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// tsconfig.app.json runs without strictNullChecks, where `if (!r.ok)` does not
// narrow these unions; reading the field through `in` does, in either mode.
export const errorOf = (r: Result<unknown>): string | null => ("error" in r ? r.error : null);

// user_roles and the jackie_morals* tables are not in the generated types until
// they are regenerated after `supabase db push`; the same cast JackieCore uses.
type Loose = { from: (t: string) => any };
const db = supabase as unknown as Loose;

// --- reading -------------------------------------------------------------------

/**
 * A missing table is the normal state until the migration has been pushed, and
 * the one the owner can fix — so it is recognised and named, not reported as a
 * generic failure that reads like tampering.
 */
export function isMissingTable(message: string): boolean {
  return /relation .* does not exist|could not find the table|schema cache|PGRST205|42P01/i.test(message);
}

async function select<T>(table: string, query: (q: any) => any): Promise<Result<T[]>> {
  try {
    const { data, error } = await query(db.from(table));
    if (error) return { ok: false, error: `${table}: ${error.message ?? String(error)}` };
    return { ok: true, data: (data ?? []) as T[] };
  } catch (e) {
    return { ok: false, error: `${table}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const loadMorals = () =>
  select<MoralRow>("jackie_morals", (q) => q.select("*").order("sort_order").order("created_at"));
export const loadLedger = () =>
  select<LedgerRow>("jackie_morals_ledger", (q) => q.select("*").order("seq"));
export const loadAttestations = () =>
  select<AttestationRow>("jackie_persona_attestations", (q) => q.select("*").order("last_seen", { ascending: false }));

async function callMoralsFunction<T>(body: Record<string, unknown>): Promise<Result<T>> {
  try {
    const resp = await callEdgeFunction("jackie-morals", body);
    const parsed = (await resp.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!resp.ok || !parsed) {
      return { ok: false, error: parsed?.error ?? `jackie-morals answered HTTP ${resp.status}` };
    }
    return { ok: true, data: parsed };
  } catch (e) {
    return { ok: false, error: describeEdgeFailure(e, "jackie-morals") };
  }
}

export const fetchStatus = () => callMoralsFunction<PersonaStatus>({ action: "status" });
export const sealNow = (note: string) =>
  callMoralsFunction<{ sealed: boolean; seq: number | null; hash: string | null }>({ action: "seal", note });

// --- writing -------------------------------------------------------------------

export interface MoralDraft {
  title: string;
  rule: string;
  category: MoralCategory;
  enabled?: boolean;
}

/** The same limits the database enforces, checked first so the owner gets words, not an error code. */
export function validateMoral(d: MoralDraft): string | null {
  const title = d.title.trim();
  const rule = d.rule.trim();
  if (!title) return "Give the moral a short title.";
  if (title.length > MORAL_LIMITS.maxTitle) return `Keep the title to ${MORAL_LIMITS.maxTitle} characters.`;
  if (!rule) return "Write the rule Jackie should follow.";
  if (rule.length > MORAL_LIMITS.maxRule) {
    return `Keep the rule to ${MORAL_LIMITS.maxRule} characters — it rides on every message, including to small local models.`;
  }
  if (!(MORAL_CATEGORIES as readonly string[]).includes(d.category)) return "Pick a category.";
  return null;
}

async function write(run: () => any): Promise<Result<null>> {
  try {
    const { error } = await run();
    if (error) return { ok: false, error: error.message ?? String(error) };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function addMoral(d: MoralDraft, existing: readonly MoralRow[]): Promise<Result<null>> {
  const invalid = validateMoral(d);
  if (invalid) return { ok: false, error: invalid };
  if (existing.length >= MORAL_LIMITS.maxMorals) {
    return { ok: false, error: `Jackie can hold at most ${MORAL_LIMITS.maxMorals} morals. Disable or remove one first.` };
  }
  const sort_order = existing.reduce((m, r) => Math.max(m, r.sort_order), 0) + 1;
  return write(() =>
    db.from("jackie_morals").insert({
      title: d.title.trim(), rule: d.rule.trim(), category: d.category, enabled: d.enabled ?? true, sort_order,
    }),
  );
}

export async function updateMoral(id: string, d: MoralDraft): Promise<Result<null>> {
  const invalid = validateMoral(d);
  if (invalid) return { ok: false, error: invalid };
  return write(() =>
    db.from("jackie_morals")
      .update({ title: d.title.trim(), rule: d.rule.trim(), category: d.category, enabled: d.enabled ?? true })
      .eq("id", id),
  );
}

export const setMoralEnabled = (id: string, enabled: boolean) =>
  write(() => db.from("jackie_morals").update({ enabled }).eq("id", id));

export const deleteMoral = (id: string) => write(() => db.from("jackie_morals").delete().eq("id", id));

/** Swaps two neighbours' places. Two ledger entries, which is honest: two rows changed. */
export async function swapOrder(a: MoralRow, b: MoralRow): Promise<Result<null>> {
  // Equal sort_orders (rows added in one batch) would swap to the same values;
  // spread them first so the move is visible.
  const [ao, bo] = a.sort_order === b.sort_order ? [a.sort_order + 1, a.sort_order] : [b.sort_order, a.sort_order];
  const first = await write(() => db.from("jackie_morals").update({ sort_order: ao }).eq("id", a.id));
  if (!first.ok) return first;
  return write(() => db.from("jackie_morals").update({ sort_order: bo }).eq("id", b.id));
}

/**
 * A starting set, offered and never inserted on its own. Each one says
 * something the persona does not already say, so adding them is not paying
 * twice for the same tokens on every message.
 */
export const SUGGESTED_MORALS: readonly MoralDraft[] = [
  { category: "honesty", title: "No deception, even kindly", rule: "Never deceive or manipulate the owner, even to comfort them or to make a task easier." },
  { category: "privacy", title: "Guard private data", rule: "Never share the owner's personal data, secrets or files with any person or service without their explicit go-ahead." },
  { category: "safety", title: "Ask before the irreversible", rule: "Before anything hard to undo (deleting, sending, paying, publishing), say exactly what will happen and wait for a clear yes." },
  { category: "care", title: "Wellbeing over engagement", rule: "Put the owner's long-term wellbeing ahead of keeping them engaged, and never encourage dependency on you." },
  { category: "fairness", title: "Fair to everyone", rule: "Treat every person fairly: no stereotypes, and no contempt for people the owner disagrees with." },
  { category: "safety", title: "Do no harm", rule: "Refuse to help harm people, and say plainly why rather than pretending you cannot." },
];

export async function addSuggested(existing: readonly MoralRow[]): Promise<Result<number>> {
  const have = new Set(existing.map((m) => m.title.trim().toLowerCase()));
  const fresh = SUGGESTED_MORALS.filter((m) => !have.has(m.title.toLowerCase()));
  const room = MORAL_LIMITS.maxMorals - existing.length;
  const batch = fresh.slice(0, Math.max(0, room));
  if (batch.length === 0) return { ok: true, data: 0 };
  let order = existing.reduce((m, r) => Math.max(m, r.sort_order), 0);
  const res = await write(() =>
    db.from("jackie_morals").insert(batch.map((m) => ({ ...m, enabled: true, sort_order: ++order }))),
  );
  return res.ok ? { ok: true, data: batch.length } : res;
}

// --- the ledger ------------------------------------------------------------------

export const GENESIS = "genesis";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Mirrors private.jackie_morals_append in the migration exactly. A golden
 * vector captured from PostgreSQL pins the two together in the tests.
 */
export function ledgerHash(prevHash: string, seq: number, action: string, payload: string): Promise<string> {
  return sha256Hex(`${prevHash}\n${seq}\n${action}\n${payload}`);
}

export type ChainVerdict =
  | { ok: true; count: number; head: { seq: number; hash: string } | null }
  | { ok: false; count: number; brokenAt: number; reason: string };

/**
 * Recomputes every link. Catches an entry edited in place (its hash no longer
 * matches), one removed or reordered (the next entry's prev_hash points at
 * something else, or the numbering skips), and a new first entry slipped in
 * front (it would have to start from genesis).
 */
export async function verifyLedger(rows: readonly Pick<LedgerRow, "seq" | "action" | "payload" | "prev_hash" | "hash">[]): Promise<ChainVerdict> {
  let prev = GENESIS;
  let expectSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectSeq) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: `entry #${expectSeq} is missing — the numbering jumps to #${row.seq}` };
    }
    if (row.prev_hash !== prev) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: `entry #${row.seq} does not follow the entry before it` };
    }
    const actual = await ledgerHash(row.prev_hash, row.seq, row.action, row.payload);
    if (actual !== row.hash) {
      return { ok: false, count: rows.length, brokenAt: row.seq, reason: `entry #${row.seq} was changed after it was written` };
    }
    prev = row.hash;
    expectSeq += 1;
  }
  const last = rows[rows.length - 1];
  return { ok: true, count: rows.length, head: last ? { seq: last.seq, hash: last.hash } : null };
}

export function parsePayload(row: Pick<LedgerRow, "payload">): Record<string, unknown> {
  try {
    const v = JSON.parse(row.payload);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function latestSeal(rows: readonly LedgerRow[]): SealRecord | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].action !== "seal") continue;
    const p = parsePayload(rows[i]);
    if (typeof p.persona_fp !== "string" || typeof p.morals_fp !== "string") continue;
    return {
      seq: rows[i].seq,
      at: rows[i].at,
      actor: rows[i].actor,
      persona_fp: p.persona_fp,
      persona_text: typeof p.persona_text === "string" ? p.persona_text : "",
      morals_fp: p.morals_fp,
      morals_block: typeof p.morals_block === "string" ? p.morals_block : "",
      note: typeof p.note === "string" ? p.note : undefined,
    };
  }
  return null;
}

// --- the browser's witness ---------------------------------------------------------

export interface Witness { seq: number; hash: string; at: string }
const WITNESS_KEY = "jackie-morals-witness:v1";

// Storage can be missing or throw (private windows, blocked site data). Without
// it the page still checks everything else; it just cannot remember a head.
export function readWitness(): Witness | null {
  try {
    const raw = localStorage.getItem(WITNESS_KEY);
    if (!raw) return null;
    const w = JSON.parse(raw) as Witness;
    return typeof w?.seq === "number" && typeof w?.hash === "string" ? w : null;
  } catch {
    return null;
  }
}

export function writeWitness(w: Witness): boolean {
  try {
    localStorage.setItem(WITNESS_KEY, JSON.stringify(w));
    return true;
  } catch {
    return false;
  }
}

export type WitnessVerdict =
  | { state: "none" }
  | { state: "ok" }
  | { state: "shorter"; witnessed: Witness; headSeq: number }
  | { state: "rewritten"; witnessed: Witness };

export function checkWitness(witness: Witness | null, rows: readonly Pick<LedgerRow, "seq" | "hash">[]): WitnessVerdict {
  if (!witness) return { state: "none" };
  const headSeq = rows.length ? rows[rows.length - 1].seq : 0;
  if (witness.seq > headSeq) return { state: "shorter", witnessed: witness, headSeq };
  const same = rows.find((r) => r.seq === witness.seq);
  if (!same || same.hash !== witness.hash) return { state: "rewritten", witnessed: witness };
  return { state: "ok" };
}

// --- diffs ---------------------------------------------------------------------

export type DiffLine = { kind: "same" | "added" | "removed"; text: string };

/** Line diff by longest common subsequence. The persona is ~100 lines; quadratic is fine. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i++] });
    } else {
      out.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < n) out.push({ kind: "removed", text: a[i++] });
  while (j < m) out.push({ kind: "added", text: b[j++] });
  return out;
}

// --- the assessment -------------------------------------------------------------------

export type CheckState = "ok" | "info" | "warn" | "fail";

export interface Check {
  id: string;
  state: CheckState;
  title: string;
  summary: string;
}

export interface EngineReport {
  engine: string;
  state: CheckState;
  summary: string;
  lastSeen: string | null;
  personaFp: string | null;
  moralsFp: string | null;
  overrideRequests: number;
}

export interface Assessment {
  verdict: CheckState | "setup";
  headline: string;
  checks: Check[];
  engines: EngineReport[];
  seal: SealRecord | null;
  chain: ChainVerdict | null;
  witness: WitnessVerdict;
  /** Ledger entries after the seal that changed a moral. */
  changesSinceSeal: LedgerRow[];
}

export interface AssessmentInput {
  status: Result<PersonaStatus>;
  ledger: Result<LedgerRow[]>;
  attestations: Result<AttestationRow[]>;
  chain: ChainVerdict | null;
  witness: WitnessVerdict;
  /** Engines report within this long after a change still counts as the change propagating. */
  propagationMs?: number;
}

const RANK: Record<CheckState, number> = { ok: 0, info: 0, warn: 1, fail: 2 };
const worst = (states: CheckState[]): CheckState =>
  states.reduce<CheckState>((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");
const short = (fp: string) => fp.slice(0, 12);
const when = (iso: string) => new Date(iso).toLocaleString();

export function assessIntegrity(input: AssessmentInput): Assessment {
  const propagationMs = input.propagationMs ?? 30_000;
  const checks: Check[] = [];
  const missing = [input.ledger, input.attestations]
    .map(errorOf)
    .some((e) => e !== null && isMissingTable(e));

  if (missing || (input.status.ok && input.status.data.morals.error && isMissingTable(input.status.data.morals.error))) {
    return {
      verdict: "setup",
      headline: "The guard rail is built but not switched on yet.",
      checks: [{
        id: "setup",
        state: "warn",
        title: "Database not set up",
        summary:
          "The morals tables do not exist in the database yet. Run `supabase db push`, then deploy the functions, and reload this page. Until then every engine answers on the base persona and says so.",
      }],
      engines: [],
      seal: null,
      chain: null,
      witness: input.witness,
      changesSinceSeal: [],
    };
  }

  // The ledger, then the witness: everything after leans on the history being sound.
  const rows = input.ledger.ok ? input.ledger.data : [];
  if (!input.ledger.ok) {
    checks.push({ id: "chain", state: "fail", title: "Change history", summary: `Could not read the ledger: ${errorOf(input.ledger)}` });
  } else if (input.chain && "reason" in input.chain) {
    checks.push({
      id: "chain", state: "fail", title: "Change history",
      summary: `Tampered: ${input.chain.reason}. Nothing written through the app can do this — it takes direct database access.`,
    });
  } else {
    checks.push({
      id: "chain", state: "ok", title: "Change history",
      summary: rows.length
        ? `${rows.length} ${rows.length === 1 ? "entry" : "entries"}, every hash checks out against the one before it.`
        : "Empty so far. Every change from now on is chained.",
    });
  }

  const w = input.witness;
  if (w.state === "none") {
    checks.push({
      id: "witness", state: "info", title: "This browser's memory of the history",
      summary: "First check from this browser. From now on it remembers the latest entry, and will notice if the history is ever rewritten behind it.",
    });
  } else if (w.state === "shorter") {
    checks.push({
      id: "witness", state: "fail", title: "This browser's memory of the history",
      summary: `Rewritten: this browser last saw entry #${w.witnessed.seq} (${when(w.witnessed.at)}), and the history now ends at #${w.headSeq}. Entries were removed.`,
    });
  } else if (w.state === "rewritten") {
    checks.push({
      id: "witness", state: "fail", title: "This browser's memory of the history",
      summary: `Rewritten: entry #${w.witnessed.seq} is not the one this browser verified on ${when(w.witnessed.at)}. The history was replaced with one that only looks consistent.`,
    });
  } else {
    checks.push({
      id: "witness", state: "ok", title: "This browser's memory of the history",
      summary: "The history still contains the latest entry this browser verified, unchanged.",
    });
  }

  const outside = rows.filter((r) => r.actor === null);
  if (outside.length) {
    checks.push({
      id: "outside", state: "fail", title: "Changes made outside the app",
      summary: `${outside.length} ${outside.length === 1 ? "change was" : "changes were"} made with no signed-in account — the service role, the SQL editor or a migration (entries ${outside.map((r) => `#${r.seq}`).join(", ")}). If you did not make ${outside.length === 1 ? "it" : "them"}, someone with database access did.`,
    });
  }

  // The seal, and what has moved since.
  const seal = input.ledger.ok && (!input.chain || input.chain.ok) ? latestSeal(rows) : null;
  const changesSinceSeal = seal ? rows.filter((r) => r.seq > seal.seq && r.action !== "seal") : rows.filter((r) => r.action !== "seal");
  const status = input.status.ok ? input.status.data : null;

  if (!input.status.ok) {
    checks.push({ id: "status", state: "fail", title: "Live persona", summary: `Could not ask the server what Jackie is running: ${errorOf(input.status)}` });
  }

  if (!seal) {
    checks.push({
      id: "seal", state: "warn", title: "Your seal",
      summary: "Nothing sealed yet. Review the persona and your morals below, then seal them — every later change is measured from that point.",
    });
  } else if (status) {
    checks.push(status.persona.fingerprint === seal.persona_fp
      ? { id: "persona", state: "ok", title: "Jackie's persona", summary: `Matches what you sealed on ${when(seal.at)}.` }
      : {
          id: "persona", state: "fail", title: "Jackie's persona",
          summary: `Changed since you sealed it on ${when(seal.at)} (was ${short(seal.persona_fp)}, now ${short(status.persona.fingerprint)}). This comes from code, so a deploy changed it: the Persona tab shows exactly what. If the change is yours, seal again.`,
        });
    if (status.morals.error) {
      checks.push({ id: "morals", state: "fail", title: "Your morals", summary: status.morals.error });
    } else if (status.morals.fingerprint === seal.morals_fp) {
      checks.push({ id: "morals", state: "ok", title: "Your morals", summary: `Match what you sealed on ${when(seal.at)}.` });
    } else {
      checks.push({
        id: "morals", state: "fail", title: "Your morals",
        summary: `Changed since you sealed them: ${changesSinceSeal.length} ${changesSinceSeal.length === 1 ? "change" : "changes"} after seal #${seal.seq}. History shows who made each one and Persona shows the difference; if they are yours, seal again.`,
      });
    }
  }

  // The engines: what each one actually ran.
  const engines: EngineReport[] = [];
  const atts = input.attestations.ok ? input.attestations.data : [];
  if (!input.attestations.ok) {
    checks.push({ id: "engines", state: "fail", title: "Engine reports", summary: `Could not read what the engines reported: ${errorOf(input.attestations)}` });
  }
  const lastMoralChange = rows.filter((r) => r.action !== "seal").map((r) => Date.parse(r.at)).reduce((m, t) => Math.max(m, t), 0);
  const names = Array.from(new Set([...(status?.engines ?? PERSONA_ENGINES), ...atts.map((a) => a.engine)]));
  const expectedPersona = seal?.persona_fp ?? status?.persona.fingerprint ?? null;
  const currentMorals = status && !status.morals.error ? status.morals.fingerprint : null;

  for (const engine of names) {
    const mine = atts.filter((a) => a.engine === engine);
    const personaRows = mine.filter((a) => a.mode !== "override").sort((x, y) => Date.parse(y.last_seen) - Date.parse(x.last_seen));
    const overrides = mine.filter((a) => a.mode === "override");
    const overrideRequests = overrides.reduce((n, a) => n + Number(a.requests), 0);
    const latest = personaRows[0] ?? null;
    let state: CheckState = "info";
    let summary: string;

    if (!latest) {
      summary = overrideRequests
        ? "Has only answered with a caller's own system prompt, never Jackie's persona."
        : "No requests recorded yet.";
    } else if (latest.mode === "persona-without-morals") {
      state = "fail";
      summary = `Answered without your morals on ${when(latest.last_seen)}: ${latest.detail ?? "it could not load them"}.`;
    } else if (expectedPersona && latest.persona_fp !== expectedPersona) {
      state = "fail";
      summary = seal
        ? `Running a persona you did not seal (${short(latest.persona_fp)}) since ${when(latest.first_seen)}. Its deployed code differs from what you approved.`
        : `Running a different persona (${short(latest.persona_fp)}) from the live one (${short(expectedPersona)}) — it was deployed from different code.`;
    } else if (currentMorals && latest.morals_fp !== currentMorals) {
      const stale = Date.parse(latest.last_seen) < lastMoralChange + propagationMs;
      state = stale ? "info" : "fail";
      summary = stale
        ? `Last answered on ${when(latest.last_seen)}, before your latest change to the morals. Its next answer will show whether it picked the change up.`
        : `Answered with morals that differ from the ones saved (${short(latest.morals_fp)}) on ${when(latest.last_seen)}.`;
    } else {
      state = "ok";
      summary = `Answered with ${seal ? "the sealed" : "the live"} persona and your current morals, last on ${when(latest.last_seen)} (${latest.requests} ${Number(latest.requests) === 1 ? "request" : "requests"} with this setup).`;
    }
    if (overrideRequests && latest) {
      summary += ` Also ${overrideRequests} ${overrideRequests === 1 ? "request" : "requests"} with a caller's own system prompt (Agent Lab, operators) — your morals are not added to those.`;
    }
    engines.push({
      engine, state, summary,
      lastSeen: latest?.last_seen ?? overrides[0]?.last_seen ?? null,
      personaFp: latest?.persona_fp ?? null,
      moralsFp: latest?.morals_fp ?? null,
      overrideRequests,
    });
  }

  const verdict = worst([...checks.map((c) => c.state), ...engines.map((e) => e.state)]);
  const reporting = engines.filter((e) => e.state === "ok").length;
  // "Every engine says so" only when one has said anything: an engine that has
  // not answered since the seal has confirmed nothing, and claiming otherwise is
  // the success-when-nothing-happened this repo keeps having to unlearn.
  const headline =
    verdict === "fail" ? "Something changed that you did not approve, or could not be verified."
      : verdict === "warn" ? "Nothing looks tampered with, but it is not fully under watch yet."
        : reporting === 0 ? "Intact so far: everything matches your seal. No engine has answered since, so none has confirmed it yet."
          : `Intact: everything matches what you sealed, confirmed by ${reporting} ${reporting === 1 ? "engine" : "engines"} that answered since.`;
  return { verdict, headline, checks, engines, seal, chain: input.chain, witness: input.witness, changesSinceSeal };
}
