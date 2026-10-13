/**
 * Bonsai 1.7B, downloaded into this browser and run here.
 *
 * PocketPal's idea — pick a small model, download it once, chat with it on the
 * device — for the web app. PocketPal itself is a React Native app built on
 * llama.rn and cannot be embedded in a web page; what it does can be, because
 * wllama is the same llama.cpp compiled to WebAssembly, and llama.cpp reads
 * Bonsai's 1-bit Q1_0 GGUF as it is.
 *
 * ## Which bytes
 *
 * Exactly the ones the repository's LFS pointer names: one SHA-256, one size.
 * The file comes from this app's own origin when the host serves the real
 * weights, and otherwise from Hugging Face — but only the listing whose SHA-256
 * is that one, at the commit the listing reports, and only kept if the size
 * that arrived is the size pinned here. A newer upload under the same name is
 * a different model, and running it as Jackie would be the quiet substitution
 * every other part of the chat goes out of its way to report.
 *
 * Most hosts never serve the real file: a deploy carries the 134-byte LFS
 * pointer, not 237 MB of weights, which is why the old guidance rung reported
 * "not installed" on every deployed copy of the app.
 *
 * ## Where it lives
 *
 * wllama's cache (the origin-private file system), so it survives reloads and
 * loads without the network. The download asks the browser to keep it — a
 * 237 MB file is the first thing a browser evicts when storage runs low — and
 * Remove deletes it, so nothing about the model is a mystery to the person
 * whose disk it is on.
 *
 * The chat is not offline, though: each answer first fetches Jackie's persona
 * from `jackie-device` (see jackie-router's askDevice), because the persona is
 * kept out of the bundle. What stays here is the question and the thinking.
 */
import type { ModelManager, Wllama } from "@wllama/wllama";
import { GUIDE_WEIGHTS_PATH, GUIDE_WEIGHTS_SOURCE } from "@/lib/guide/weights";
import { GUIDANCE_MODEL } from "./models";
import { createWllama, hasWebGpu, loadWllamaModule, needsCompatBuild, supportsDeviceModels } from "./wllamaRuntime";

/** The build Jackie runs: what public/models/bonsai-1.7b/bonsai-1.7b.gguf's LFS pointer names. */
export const BONSAI_SHA256 = "3d7c6c90dd98717a203adb22d5eacd2581850e40aa5327e144b97766cae5f7e3";
export const BONSAI_BYTES = 248_302_272;
export const BONSAI_MB = Math.round(BONSAI_BYTES / (1024 * 1024));

/**
 * The window the model is loaded with. Each token of it costs about 112 KB of
 * memory on top of the weights, so 4,096 is roughly 460 MB — what a laptop and
 * a recent phone can spare. Jackie's persona is about 1,300 of them.
 */
export const BONSAI_CONTEXT_TOKENS = 4096;
export const BONSAI_MAX_ANSWER_TOKENS = 512;
/** Memory context sent with the persona. The tail is kept, as everywhere else. */
export const BONSAI_CONTEXT_CHARS = 2000;

const HF = "https://huggingface.co";

export const UNSUPPORTED_BROWSER = "This browser cannot run WebAssembly, which Bonsai needs to run here.";

export const NOT_DOWNLOADED =
  `Bonsai is not on this device yet. Choose On-device in the engine menu and download it (${BONSAI_MB} MB, once).`;

/** For callers that may fetch only from this app, never from a third party unasked. */
export const NOT_ON_THIS_HOST =
  `This host serves only the LFS pointer for Bonsai, not the weights. Download it once from the chat (On-device engine), or run git lfs pull on a self-hosted copy.`;

/** Shaped like appActions' ActionResult, so `.error` reads without narrowing in this non-strict build. */
export type Verdict<T extends object = object> =
  | ({ ok: true; error?: undefined; aborted?: undefined } & T)
  | { ok: false; error: string; aborted?: boolean };

export interface BonsaiSource {
  url: string;
  from: "this app" | "Hugging Face";
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function sameOriginUrl(origin: string): string {
  return new URL(GUIDE_WEIGHTS_PATH, origin).href;
}

/**
 * True for a cached model that came from one of the places Bonsai is fetched
 * from. The bare path is the Guide's device rung, which loads the same file by
 * its relative URL — one copy on disk serves both.
 */
export function isBonsaiUrl(url: string, origin: string = globalThis.location?.origin ?? "http://localhost"): boolean {
  return url === GUIDE_WEIGHTS_PATH || url === sameOriginUrl(origin) || url.startsWith(`${HF}/${GUIDE_WEIGHTS_SOURCE}/resolve/`);
}

/**
 * Where to download the pinned build from. Never throws.
 *
 * The app's own copy first: no third party, and on a self-hosted rig the
 * fastest link there is. It counts only at the exact pinned size — a pointer
 * file is 134 bytes, and a different build is a different number.
 */
export async function resolveBonsaiSource(
  fetchImpl: typeof fetch = fetch,
  origin: string = globalThis.location?.origin ?? "http://localhost",
  { ownOriginOnly = false }: { ownOriginOnly?: boolean } = {},
): Promise<Verdict<{ source: BonsaiSource }>> {
  try {
    const head = await fetchImpl(GUIDE_WEIGHTS_PATH, { method: "HEAD" });
    if (head.ok && Number(head.headers.get("content-length")) === BONSAI_BYTES) {
      return { ok: true, source: { url: sameOriginUrl(origin), from: "this app" } };
    }
  } catch {
    /* not served here; Hugging Face is the other source */
  }
  if (ownOriginOnly) return { ok: false, error: NOT_ON_THIS_HOST };

  let listing: { sha?: unknown; siblings?: unknown } | null;
  try {
    const res = await fetchImpl(`${HF}/api/models/${GUIDE_WEIGHTS_SOURCE}?blobs=true`);
    if (!res.ok) {
      return { ok: false, error: `Hugging Face answered HTTP ${res.status} for ${GUIDE_WEIGHTS_SOURCE}, so Bonsai could not be downloaded.` };
    }
    listing = await res.json();
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach Hugging Face to download Bonsai (${message(e)}). This app's host does not serve the weights itself, so the first download needs a connection.`,
    };
  }

  type Sibling = { rfilename?: unknown; lfs?: { sha256?: unknown; oid?: unknown } };
  const siblings = Array.isArray(listing?.siblings) ? (listing.siblings as Sibling[]) : [];
  const match = siblings.find(
    (s) => typeof s?.rfilename === "string" && /\.gguf$/i.test(s.rfilename) && (s.lfs?.sha256 ?? s.lfs?.oid) === BONSAI_SHA256,
  );
  if (!match) {
    return {
      ok: false,
      error: `${GUIDE_WEIGHTS_SOURCE} on Hugging Face no longer lists the build Jackie pins (sha256 ${BONSAI_SHA256.slice(0, 12)}…), so nothing was downloaded.`,
    };
  }
  // The commit the listing came from, so the file fetched is the file that
  // was listed even if the repository moves on in between.
  const revision = typeof listing?.sha === "string" && /^[0-9a-f]{40}$/.test(listing.sha) ? listing.sha : "main";
  const path = (match.rfilename as string).split("/").map(encodeURIComponent).join("/");
  return { ok: true, source: { url: `${HF}/${GUIDE_WEIGHTS_SOURCE}/resolve/${revision}/${path}`, from: "Hugging Face" } };
}

let managerPromise: Promise<ModelManager> | null = null;

function manager(): Promise<ModelManager> {
  // A chunk that failed to load (a deploy landed mid-session, the network
  // blinked) must not be remembered: the next press should try again.
  managerPromise ??= loadWllamaModule()
    .then(({ ModelManager }) => new ModelManager({ allowOffline: true }))
    .catch((e) => {
      managerPromise = null;
      throw e;
    });
  return managerPromise;
}

export interface BonsaiStatus {
  supported: boolean;
  downloaded: boolean;
  /** A download that stopped partway left files behind; Remove clears them. */
  partial: boolean;
  gpu: boolean;
  /** Runs wllama's slower compatibility build: Safari, every iOS browser. */
  compat: boolean;
  error?: string;
}

export type StoredBonsai = Omit<BonsaiStatus, "gpu" | "compat">;

/**
 * Whether this browser can run Bonsai and has it stored. Reads the cache,
 * never the network, and leaves the GPU alone: the Guide's ladder asks this
 * on every route, and asking for a WebGPU adapter is not free.
 */
export async function storedBonsai(): Promise<StoredBonsai> {
  if (!supportsDeviceModels()) return { supported: false, downloaded: false, partial: false };
  try {
    const all = (await (await manager()).getModels({ includeInvalid: true })).filter((m) => isBonsaiUrl(m.url));
    const ready = all.some((m) => m.validate() === "valid" && m.size === BONSAI_BYTES);
    return { supported: true, downloaded: ready, partial: !ready && all.length > 0 };
  } catch (e) {
    return { supported: true, downloaded: false, partial: false, error: `Could not read this browser's model storage: ${message(e)}` };
  }
}

/** Everything the panel shows: what is stored, and whether a GPU will run it. */
export async function bonsaiStatus(): Promise<BonsaiStatus> {
  const [stored, gpu] = await Promise.all([storedBonsai(), hasWebGpu()]);
  return { ...stored, gpu, compat: needsCompatBuild() };
}

export interface DownloadProgress {
  loaded: number;
  total: number;
}

interface DownloadJob {
  progress: DownloadProgress;
  controller: AbortController;
  listeners: Set<(p: DownloadProgress) => void>;
  result: Promise<Verdict<{ from: BonsaiSource["from"] }>>;
}

/**
 * The download in flight, if any. One per tab, owned by this module rather
 * than by whichever panel started it: a 237 MB download tied to a component
 * was cancelled by switching engine for a moment, and two panels pressing
 * Download wrote the same file twice at once.
 */
let job: DownloadJob | null = null;

/** Progress of the download in flight, or null when none is. */
export function bonsaiDownloadInProgress(): DownloadProgress | null {
  return job ? { ...job.progress } : null;
}

/** Cancels the download in flight. What arrived is deleted. */
export function stopBonsaiDownload(): void {
  job?.controller.abort();
}

/**
 * Downloads the pinned Bonsai, or joins the download already running.
 *
 * `onProgress` hears the shared download, from where it has got to. `signal`
 * cancels it for everyone, which is what a Stop button means. A caller that
 * merely goes away — a panel unmounting — should pass neither and let it run.
 */
export function downloadBonsai(
  opts: {
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    /** Fetch only from this app, never from Hugging Face. Ignored when joining a download. */
    ownOriginOnly?: boolean;
  } = {},
): Promise<Verdict<{ from: BonsaiSource["from"] }>> {
  if (!job) {
    const controller = new AbortController();
    const current: DownloadJob = {
      progress: { loaded: 0, total: BONSAI_BYTES },
      controller,
      listeners: new Set(),
      result: Promise.resolve({ ok: false, error: "not started" }),
    };
    current.result = runDownload({
      fetchImpl: opts.fetchImpl,
      ownOriginOnly: opts.ownOriginOnly,
      signal: controller.signal,
      onProgress: (p) => {
        current.progress = p;
        for (const listener of current.listeners) listener(p);
      },
    }).finally(() => {
      if (job === current) job = null;
    });
    job = current;
  }
  const active = job;
  const { onProgress, signal } = opts;
  if (onProgress) {
    active.listeners.add(onProgress);
    onProgress({ ...active.progress });
  }
  if (signal) {
    if (signal.aborted) active.controller.abort();
    else signal.addEventListener("abort", () => active.controller.abort(), { once: true });
  }
  return active.result.finally(() => {
    if (onProgress) active.listeners.delete(onProgress);
  });
}

async function runDownload(opts: {
  onProgress: (p: DownloadProgress) => void;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  ownOriginOnly?: boolean;
}): Promise<Verdict<{ from: BonsaiSource["from"] }>> {
  if (!supportsDeviceModels()) return { ok: false, error: UNSUPPORTED_BROWSER };
  const resolved = await resolveBonsaiSource(opts.fetchImpl, undefined, { ownOriginOnly: opts.ownOriginOnly });
  if (resolved.ok === false) return { ok: false, error: resolved.error };

  // Best effort: without it the browser may evict 237 MB the next time
  // storage runs low, and the next question finds the model gone.
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* refused or unsupported; the download still works */
  }

  let mm: ModelManager;
  try {
    mm = await manager();
  } catch (e) {
    return { ok: false, error: `The model runtime did not load: ${message(e)}` };
  }
  // wllama closes the file when a download breaks, so a stopped one leaves
  // its bytes on disk with no record of what they are: invisible to Remove,
  // and never reclaimed if the next download comes from a different URL.
  const discardPartial = () => mm.cacheManager.delete(resolved.source.url).catch(() => undefined);
  try {
    const model = await mm.downloadModel(resolved.source.url, {
      progressCallback: ({ loaded, total }) => opts.onProgress({ loaded, total: total || BONSAI_BYTES }),
      signal: opts.signal,
    });
    if (model.size !== BONSAI_BYTES) {
      await model.remove().catch(() => undefined);
      return {
        ok: false,
        error: `The download ended at ${model.size.toLocaleString()} bytes, not the ${BONSAI_BYTES.toLocaleString()} Bonsai is, so it was deleted. Try again.`,
      };
    }
    return { ok: true, from: resolved.source.from };
  } catch (e) {
    await discardPartial();
    if (opts.signal.aborted || (e as Error)?.name === "AbortError") {
      return { ok: false, aborted: true, error: "Download stopped, and the part that arrived was deleted." };
    }
    if (/quota/i.test(message(e))) {
      return { ok: false, error: `This browser has no room for Bonsai's ${BONSAI_MB} MB. Free some space and try again.` };
    }
    return { ok: false, error: `Bonsai did not download: ${message(e)}` };
  }
}

/**
 * Bonsai in this browser's storage, fetching it from this app if it is not —
 * never from Hugging Face. For the Guide's device rung, which runs without
 * anyone pressing Download: 237 MB from a third party is the owner's call, and
 * the chat's panel is where they make it.
 */
export async function ensureBonsai(opts: { onProgress?: (p: DownloadProgress) => void } = {}): Promise<Verdict> {
  if (job) {
    const joined = await downloadBonsai({ onProgress: opts.onProgress });
    return joined.ok ? { ok: true } : { ok: false, error: joined.error };
  }
  const status = await storedBonsai();
  if (status.downloaded) return { ok: true };
  if (!status.supported) return { ok: false, error: UNSUPPORTED_BROWSER };
  const fetched = await downloadBonsai({ onProgress: opts.onProgress, ownOriginOnly: true });
  return fetched.ok ? { ok: true } : { ok: false, error: fetched.error };
}

/**
 * One loaded Bonsai per tab, shared by the chat and the Guide's device rung.
 * Each used to be able to hold its own, and two copies of the model plus two
 * KV caches is more memory than a phone will give a tab.
 */
let session: Promise<Wllama> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** One generation at a time on the shared model, in the order asked. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

function acquireSession(onLoading?: () => void): Promise<Wllama> {
  if (!session) {
    onLoading?.();
    const opening = openSession();
    session = opening;
    // A failed load is not remembered: the usual cause (not downloaded yet)
    // is fixed by a download, not by a reload.
    opening.catch(() => {
      if (session === opening) session = null;
    });
  }
  return session;
}

/** Runs `fn` against the loaded model, in turn with every other use of it. */
export function withBonsai<T>(fn: (wllama: Wllama) => Promise<T>): Promise<T> {
  return serialized(async () => fn(await acquireSession()));
}

async function openSession(): Promise<Wllama> {
  const mm = await manager();
  const model = (await mm.getModels()).find((m) => isBonsaiUrl(m.url) && m.size === BONSAI_BYTES);
  if (!model) throw new Error(NOT_DOWNLOADED);
  const wllama = await createWllama({ modelManager: mm });
  // Every layer goes to WebGPU when the browser has it, and llama.cpp falls
  // back to the CPU on its own when it does not.
  await wllama.loadModel(model, {
    n_ctx: BONSAI_CONTEXT_TOKENS,
    // The compatibility build is what a phone runs, and a phone gives a tab a
    // fraction of a desktop's memory. Keys stored at 8 bits take about 115 MB
    // off the 460 MB the window costs, for a small loss of precision; values
    // stay at 16 because quantizing them needs flash attention.
    ...(needsCompatBuild() ? { cache_type_k: "q8_0" as const } : {}),
  });
  return wllama;
}

/**
 * Frees the memory the loaded model holds. The download stays. Waits its turn
 * behind any answer in progress, so it never pulls the model out from under a
 * generation that the chat or the Guide is still reading.
 */
export function unloadBonsai(): Promise<void> {
  return serialized(async () => {
    const current = session;
    session = null;
    if (!current) return;
    try {
      await (await current).exit();
    } catch {
      /* it never finished loading, so there is nothing to free */
    }
  });
}

export async function removeBonsai(): Promise<Verdict> {
  // A download still running would write the file straight back.
  const running = job;
  if (running) {
    running.controller.abort();
    await running.result;
  }
  await unloadBonsai();
  try {
    const all = (await (await manager()).getModels({ includeInvalid: true })).filter((m) => isBonsaiUrl(m.url));
    for (const model of all) await model.remove();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `Bonsai could not be removed: ${message(e)}` };
  }
}

export interface DeviceMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * The conversation, cut to what fits beside the system prompt in the window.
 *
 * Oldest turns go first; the question being asked never does. Null when even
 * the system prompt and that question cannot fit, which the caller reports
 * rather than letting llama.cpp refuse it with an error about slots.
 *
 * Counted in characters at 3.5 a token, below the ~4.6 Jackie's persona
 * actually measures, so the estimate errs toward cutting a turn too many.
 */
export function fitToWindow(
  system: string,
  messages: DeviceMessage[],
  windowTokens = BONSAI_CONTEXT_TOKENS,
  answerTokens = BONSAI_MAX_ANSWER_TOKENS,
): DeviceMessage[] | null {
  const budget = (windowTokens - answerTokens) * 3.5 - system.length;
  const kept: DeviceMessage[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = messages[i].content.length + 16; // role markers
    if (used + cost > budget) break;
    kept.unshift(messages[i]);
    used += cost;
  }
  if (!messages.length || kept[kept.length - 1] !== messages[messages.length - 1]) return null;
  // A window that opens on an orphaned reply reads as if Jackie spoke first.
  while (kept.length > 1 && kept[0].role !== "user") kept.shift();
  return kept;
}

interface ChunkLike {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
  prompt_progress?: { total: number; cache: number; processed: number };
}

/** What `chatOnDevice` needs from a loaded model. Tests stand in for it. */
export interface DeviceChatRuntime {
  createChatCompletion(options: Record<string, unknown> & { onData: (chunk: ChunkLike) => void }): Promise<unknown>;
}

export interface DeviceChatOptions {
  system: string;
  messages: DeviceMessage[];
  onDelta: (text: string) => void;
  /** A line for the screen while nothing has been written yet; null once text flows. */
  onStatus?: (note: string | null) => void;
  signal?: AbortSignal;
  /** Injected for tests. Real code loads Bonsai. */
  runtime?: () => Promise<DeviceChatRuntime>;
}

/**
 * One answer from Bonsai, streamed. Never throws; one question at a time.
 *
 * The persona is the long part — about 1,300 tokens — and the only slow one on
 * a CPU. `cache_prompt` keeps it in llama.cpp's KV cache between questions, so
 * only the first answer of a session pays for reading it.
 */
export function chatOnDevice(opts: DeviceChatOptions): Promise<Verdict> {
  return serialized(() => answer(opts));
}

async function answer(opts: DeviceChatOptions): Promise<Verdict> {
  const stopped = { ok: false as const, aborted: true, error: "Stopped." };
  if (opts.signal?.aborted) return stopped;

  const fitted = fitToWindow(opts.system, opts.messages);
  if (!fitted) {
    return {
      ok: false,
      error: `Jackie's persona and this message do not fit in Bonsai's ${BONSAI_CONTEXT_TOKENS.toLocaleString()}-token window. Send a shorter message.`,
    };
  }

  let runtime: DeviceChatRuntime;
  try {
    runtime = opts.runtime
      ? await opts.runtime()
      : ((await acquireSession(() => opts.onStatus?.(`Loading ${GUIDANCE_MODEL.name} on this device…`))) as unknown as DeviceChatRuntime);
  } catch (e) {
    opts.onStatus?.(null);
    const text = message(e);
    return { ok: false, error: text === NOT_DOWNLOADED ? text : `${GUIDANCE_MODEL.name} could not start on this device: ${text}` };
  }

  let text = "";
  let finish: string | null = null;
  try {
    await runtime.createChatCompletion({
      messages: [{ role: "system", content: opts.system }, ...fitted],
      stream: true,
      max_tokens: BONSAI_MAX_ANSWER_TOKENS,
      temperature: 0.7,
      cache_prompt: true,
      return_progress: true,
      // Qwen-family templates think aloud first unless told not to; on a model
      // reading at CPU speed, that is minutes of tokens nobody sees.
      chat_template_kwargs: { enable_thinking: false },
      abortSignal: opts.signal,
      onData: (chunk: ChunkLike) => {
        const progress = chunk.prompt_progress;
        if (progress && !text && progress.total > 0) {
          const pct = Math.min(100, Math.round((progress.processed / progress.total) * 100));
          const reused = progress.cache > 0 ? `, ${progress.cache.toLocaleString()} remembered from before` : "";
          opts.onStatus?.(`Bonsai is reading the conversation — ${pct}% of ${progress.total.toLocaleString()} tokens${reused}`);
        }
        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta?.content;
          if (delta) {
            if (!text) opts.onStatus?.(null);
            text += delta;
            opts.onDelta(delta);
          }
          if (choice.finish_reason) finish = choice.finish_reason;
        }
      },
    });
  } catch (e) {
    opts.onStatus?.(null);
    if (opts.signal?.aborted || (e as Error)?.name === "AbortError") return stopped;
    return { ok: false, error: `${GUIDANCE_MODEL.name} stopped partway: ${message(e)}` };
  }
  opts.onStatus?.(null);
  if (opts.signal?.aborted) return stopped;

  if (finish === "content_filter") {
    return { ok: false, error: `${GUIDANCE_MODEL.name} stopped: that prompt tripped its content filter.` };
  }
  if (!text.trim()) {
    // Rule 8: a model that wrote nothing has not answered.
    return { ok: false, error: `${GUIDANCE_MODEL.name} ran on this device and wrote nothing. Try again, or a shorter message.` };
  }
  return { ok: true };
}
