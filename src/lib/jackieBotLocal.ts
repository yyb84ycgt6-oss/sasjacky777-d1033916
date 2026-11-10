/**
 * Jackie's bot, answered by the owner's own LM Studio on 127.0.0.1:1234.
 *
 * A cloud function cannot reach a loopback port on the owner's PC, so the
 * browser does the call: it takes Jackie's guarded persona from `jackie-device`
 * (saved on the device, so it still works offline) and sends it as the system
 * prompt straight to LM Studio. No proxy or router (LiteLLM or otherwise) sits
 * between them — one hop, loopback only.
 */
import { LM_STUDIO_HOST, listModels, pickModel } from "./lmStudio";
import { fetchDevicePersona } from "./microai/devicePersona";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LocalBotResult =
  | { ok: true; reply: string; model: string; personaFromCache: boolean }
  | { ok: false; error: string };

export interface LocalBotDeps {
  persona?: () => Promise<{ ok: true; prompt: string; fromCache?: boolean } | { ok: false; issue: { title: string; recovery: string } }>;
  fetchImpl?: FetchLike;
}

export async function askJackieBotLocal(
  message: string,
  options: { model?: string; history?: Array<{ role: "user" | "assistant"; content: string }> } = {},
  deps: LocalBotDeps = {},
): Promise<LocalBotResult> {
  const text = message.trim();
  if (!text) return { ok: false, error: "Type a message first." };
  const fetchImpl = deps.fetchImpl ?? fetch;

  const persona = await (deps.persona ?? (() => fetchDevicePersona()))();
  // Without her persona this would be an anonymous model, so refuse instead.
  if (!persona.ok) return { ok: false, error: `${persona.issue.title}. ${persona.issue.recovery}` };

  const model = pickModel(await listModels(fetchImpl), options.model);
  if (!model) {
    return { ok: false, error: `LM Studio is not answering at ${LM_STUDIO_HOST}, or has no model loaded. Start its server and load a model.` };
  }

  try {
    const res = await fetchImpl(`${LM_STUDIO_HOST}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: persona.prompt }, ...(options.history ?? []), { role: "user", content: text }],
        temperature: 0.4,
        stream: false,
      }),
    });
    if (!res.ok) return { ok: false, error: `LM Studio refused the request (HTTP ${res.status}).` };
    const body = (await res.json()) as { model?: string; choices?: Array<{ message?: { content?: string } }> };
    const reply = (body.choices?.[0]?.message?.content ?? "").trim();
    // An empty answer is a failure, never a blank success (rule 8).
    if (!reply) return { ok: false, error: "LM Studio returned an empty answer. Check the loaded model." };
    return { ok: true, reply, model: body.model ?? model, personaFromCache: !!persona.fromCache };
  } catch {
    return { ok: false, error: `Could not reach LM Studio at ${LM_STUDIO_HOST}. Is its server running with CORS enabled?` };
  }
}
