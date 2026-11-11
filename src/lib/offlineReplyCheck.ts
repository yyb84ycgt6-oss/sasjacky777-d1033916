import { askJackieBotLocal } from "./jackieBotLocal";
import { currentUserId, loadDevicePersona } from "./microai/personaCache";
import type { CheckResult } from "./offlineResilience";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface ReplyDeps {
  userId?: () => Promise<string | null>;
  persona?: typeof loadDevicePersona;
  fetchImpl?: FetchLike;
}

/** Uses only the saved account profile and loopback; no refresh or fallback. */
export async function verifyOfflineReply(deps: ReplyDeps = {}): Promise<CheckResult> {
  const base = { id: "reply", label: "Real local reply · saved persona" };
  try {
    const uid = await (deps.userId ?? currentUserId)();
    const persona = await (deps.persona ?? loadDevicePersona)(uid);
    if (!persona) return { ...base, status: "fail", detail: "No usable saved persona for this account. Open Jackie's bot online once, then retry." };
    // Discovery and inference share one deadline, including a server that stalls.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const fetchImpl: FetchLike = (url, init) => (deps.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
      const result = await askJackieBotLocal("In one short sentence, confirm you received this local connection test.", {}, {
        fetchImpl,
        persona: async () => ({ ok: true, prompt: persona.prompt, fromCache: true }),
      });
      if (!result.ok) return { ...base, status: "fail", detail: result.error };
      // The report deliberately excludes reply text and any profile content.
      return { ...base, status: "pass", detail: `${result.model} generated a nonempty reply using the saved persona. No online provider was called. Offline page reopening is a separate check.` };
    } finally { clearTimeout(timer); }
  } catch {
    return { ...base, status: "fail", detail: "Local reply could not be verified. Check LM Studio and this browser's saved persona, then retry." };
  }
}