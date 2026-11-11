/**
 * Offline Resilience Suite: one pass that says, in plain words, whether Jackie
 * can still answer with the network gone. Each check reports what it actually
 * observed — never a pass it did not measure (rule 8).
 */
import { listModels } from "./lmStudio";
import { currentUserId, loadDevicePersona, PERSONA_MAX_AGE_MS } from "./microai/personaCache";
import { DEVICE_BUDGET_MB } from "./microai/budget";

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult { id: string; label: string; status: CheckStatus; detail: string }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface ResilienceDeps {
  fetchImpl?: FetchLike;
  userId?: () => Promise<string | null>;
  persona?: (userId: string | null) => Promise<{ fetchedAt: number } | null>;
  estimate?: () => Promise<{ usage?: number } | null>;
  persisted?: () => Promise<boolean | null>;
  serviceWorker?: () => Promise<boolean>;
  now?: number;
}

const MB = 1024 * 1024;

export async function checkLmStudio(fetchImpl?: FetchLike): Promise<CheckResult> {
  const models = await listModels(fetchImpl);
  return models.length
    ? { id: "lmstudio", label: "LM Studio on this PC", status: "pass", detail: `Server lists ${models.length} model(s): ${models.slice(0, 3).join(", ")}. A generated reply has not been tested.` }
    : { id: "lmstudio", label: "LM Studio on this PC", status: "fail", detail: "Not answering at 127.0.0.1:1234, or no model loaded. Start its server with CORS on and load a model." };
}

export function judgePersona(found: { fetchedAt: number } | null, now: number): CheckResult {
  const base = { id: "persona", label: "Jackie's persona saved on this device" };
  if (!found) return { ...base, status: "fail", detail: "No saved copy. Open Jackie's bot once while online so she can answer offline." };
  const age = now - found.fetchedAt;
  if (!Number.isFinite(found.fetchedAt) || age < 0 || age >= PERSONA_MAX_AGE_MS) return { ...base, status: "fail", detail: "Saved copy is expired or has an invalid date. Open Jackie's bot online to refresh it." };
  const daysLeft = Math.floor((PERSONA_MAX_AGE_MS - (now - found.fetchedAt)) / 86_400_000);
  if (daysLeft < 3) return { ...base, status: "warn", detail: `Saved copy expires in ${Math.max(daysLeft, 0)} day(s). Go online once to refresh it.` };
  return { ...base, status: "pass", detail: `Saved; good offline for ${daysLeft} more day(s).` };
}

export function judgeStorage(usageBytes: number | undefined, persisted: boolean | null): CheckResult {
  const base = { id: "storage", label: "Device storage budget" };
  if (usageBytes === undefined) return { ...base, status: "warn", detail: "This browser does not report storage use." };
  const used = Math.round(usageBytes / MB);
  if (!Number.isFinite(usageBytes) || usageBytes < 0) return { ...base, status: "warn", detail: "This browser reported an invalid storage measurement." };
  if (usageBytes > DEVICE_BUDGET_MB.total * MB) return { ...base, status: "fail", detail: `${used} MB used — over the ${DEVICE_BUDGET_MB.total} MB budget.` };
  if (persisted === null) return { ...base, status: "warn", detail: `${used} MB of ${DEVICE_BUDGET_MB.total} MB used; protection from clearing could not be verified.` };
  if (persisted === false) return { ...base, status: "warn", detail: `${used} MB of ${DEVICE_BUDGET_MB.total} MB used, but the browser may clear it under pressure.` };
  return { ...base, status: "pass", detail: `${used} MB of ${DEVICE_BUDGET_MB.total} MB used${persisted ? ", protected from clearing" : ""}.` };
}

export async function runResilienceSuite(deps: ResilienceDeps = {}): Promise<CheckResult[]> {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const now = deps.now ?? Date.now();
  const uid = await (deps.userId ?? currentUserId)().catch(() => null);
  const [lm, persona, est, persisted, sw] = await Promise.all([
    checkLmStudio(deps.fetchImpl),
    (deps.persona ?? ((u) => loadDevicePersona(u)))(uid).catch(() => null),
    (deps.estimate ?? (async () => (nav?.storage?.estimate ? nav.storage.estimate() : null)))().catch(() => null),
    (deps.persisted ?? (async () => (nav?.storage?.persisted ? nav.storage.persisted() : null)))().catch(() => null),
    (deps.serviceWorker ?? (async () => !!(await nav?.serviceWorker?.getRegistration?.())))().catch(() => false),
  ]);
  return [
    lm,
    judgePersona(persona, now),
    judgeStorage(est?.usage, persisted),
    sw
      ? { id: "pages", label: "Pages saved for offline", status: "warn", detail: "An offline worker is registered. Reopening this page with the internet disconnected has not been verified." }
      : { id: "pages", label: "Pages saved for offline", status: "fail", detail: "Offline page cache is not installed. Open the published app once online." },
  ];
}

/** Warnings are unverified evidence, not a successful offline run. */
export function summarizeChecks(results: CheckResult[]): string {
  if (results.some((r) => r.status === "fail")) return "Checks found blockers.";
  if (results.some((r) => r.status === "warn")) return "Checks completed; offline operation still needs verification.";
  return "Checks passed; disconnect the internet and reopen Jackie to verify offline operation.";
}

export function resilienceReport(results: CheckResult[], checkedAt: string): string {
  return JSON.stringify({ checkedAt, scope: "This browser and device only", summary: summarizeChecks(results), checks: results }, null, 2);
}
