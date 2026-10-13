/**
 * One way to start llama.cpp in the tab, for every engine that runs a GGUF here.
 *
 * The import is dynamic because the static one put the library and its 8 MB
 * WebAssembly binary into the main bundle — paid for by every visitor to every
 * route, including the ones who never ask a question, and including the ones on
 * a phone. Nothing about running a model on the device should cost anything
 * until it answers.
 */
import type { ModelManager, Wllama } from "@wllama/wllama";

export type WllamaModule = typeof import("@wllama/wllama");

export function loadWllamaModule(): Promise<WllamaModule> {
  return import("@wllama/wllama");
}

export async function createWllama(options: { modelManager?: ModelManager } = {}): Promise<Wllama> {
  const { Wllama: WllamaClass } = await loadWllamaModule();
  // Vite fingerprints this and emits it as a build asset, so the binary is
  // served from this origin like everything else. The alternative wllama offers
  // is a CDN, which would make the offline-first engine depend on a third party
  // being reachable — the one thing this ladder exists to avoid.
  const { default: wasmUrl } = await import("@wllama/wllama/esm/wasm/wllama.wasm?url");
  const wllama = new WllamaClass(
    // The key has to be exactly "wllama.wasm": wllama throws
    // `"wllama.wasm" is missing in pathConfig` without it, and its `locateFile`
    // returns `pathConfig[filename]` with no fallback, so `default` alone does
    // not satisfy it. The shipped `AssetsPathConfig` type declares neither —
    // it still describes the old single-thread/multi-thread split — so the cast
    // is against a stale declaration, not against the runtime.
    { "wllama.wasm": wasmUrl, default: wasmUrl } as unknown as ConstructorParameters<typeof WllamaClass>[0],
    {
      suppressNativeLog: true,
      // Answer from the cached weights when the network is gone. Without this
      // the engine that exists to work offline refuses to start offline.
      allowOffline: true,
      ...(options.modelManager ? { modelManager: options.modelManager } : {}),
    },
  );
  // wllama's constructor opts every browser without JSPI or 64-bit memory —
  // Safari, and Firefox unless a flag is set — into a "compat" build fetched
  // from cdn.jsdelivr.net at load time: code from a third party, run with the
  // owner's persona and memory in the same tab. Turned off, those browsers run
  // the same-origin build or fail to start it, and a failure is named by the
  // caller instead of quietly trading where the code comes from.
  wllama.setCompat(null);
  return wllama;
}

/**
 * Whether this browser has what the same-origin build needs: 64-bit
 * WebAssembly memory. Asked before a 237 MB download rather than after it.
 */
export function supportsDeviceModels(): boolean {
  try {
    if (typeof WebAssembly !== "object") return false;
    new WebAssembly.Memory({ address: "i64", initial: BigInt(1) } as unknown as WebAssembly.MemoryDescriptor);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the browser will lend a GPU to WebGPU, which llama.cpp then uses on
 * its own. `navigator.gpu` alone is not enough: headless and blocklisted
 * browsers expose it and then hand out no adapter, and a panel that promised
 * the GPU would leave the person waiting minutes on the CPU with no warning.
 */
export async function hasWebGpu(): Promise<boolean> {
  try {
    const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch {
    return false;
  }
}
