# On-device in the chat: Bonsai 1.7B in the browser

Jackie's chat can answer from **Bonsai 1.7B running in the browser tab**: pick
**On-device** in the engine menu, press **Download (237 MB)** once, and ask.
No AI provider sees the question. This is what PocketPal does on a phone,
done inside the web app.

It builds on the device rung (`docs/ON_DEVICE.md`), which runs the same weights
in the tab for the Guide and the Keeper router. The two share one download and
one loaded model: on a host that deploys only the LFS pointer, downloading
Bonsai here is also what makes the Guide's rung available, and a tab that uses
both holds one copy of the model in memory, not two.

## Why not PocketPal itself

PocketPal is a React Native app built on `llama.rn`, the native llama.cpp
binding for iOS and Android. A web page cannot embed it. What can be embedded
is the engine underneath it: **wllama** is the same llama.cpp compiled to
WebAssembly. It reads Bonsai's 1-bit `Q1_0` GGUF as published, and it was
already a dependency (the guidance rung in `deviceEngine.ts`).

## Using it

1. Open the chat, open the engine menu (the chip left of the model name), and
   choose **On-device (Bonsai 1.7B)**. It sits below the numbered chain.
2. The panel above the composer says whether this browser can run it and
   whether it has WebGPU. Press **Download**. Progress is shown; **Stop**
   cancels it and deletes the part that arrived. Switching engine does not:
   the download belongs to the page, not the panel, and the panel picks it
   up again when you come back.
3. Ask. The first answer of a session loads the model and reads Jackie's
   persona, and the composer shows how far it has got. Later answers reuse
   what was read (llama.cpp's prompt cache), so they start much sooner.
4. **Remove** deletes the 237 MB from this browser.

It needs the **owner** account (see below) and a browser with 64-bit
WebAssembly memory, which current Chrome, Edge and Firefox have. A browser
without it is told so before anything downloads.

## Which bytes, from where

Exactly one build: SHA-256 `3d7c6c90…cae5f7e3`, 248,302,272 bytes — the file
`public/models/bonsai-1.7b/bonsai-1.7b.gguf`'s LFS pointer names. A test reads
that pointer and fails if the pins in `bonsaiDevice.ts` drift from it.

- **From the app itself**, when the host serves the real weights at
  `/models/bonsai-1.7b/bonsai-1.7b.gguf` at exactly that size. A self-hosted
  build after `git lfs pull` does.
- **Otherwise from Hugging Face** (`prism-ml/Bonsai-1.7B-gguf`). Most hosts,
  Lovable's included, deploy the 134-byte LFS pointer rather than the weights.
  The app asks Hugging Face's API for the repository's file list, takes only
  the file whose SHA-256 is the pinned one, and downloads it from the commit
  that list came from. If the repository no longer has that build, nothing is
  downloaded and the panel says why. A newer upload under the same name is a
  different model.

Either way the size that arrives is checked against the pin, and a download of
the wrong size is deleted.

The file is kept in wllama's cache, in the browser's origin-private file system,
and the download asks the browser to keep it (`navigator.storage.persist()`), so
it is not the first thing evicted when the disk fills.

## What leaves the machine

- **The question and the answer stay in the tab** as far as any model is
  concerned: Bonsai runs here.
- **The chat is still saved** to your history in the database, as it is for
  every engine, and memories are extracted from it the same way.
- **Before each answer, one request goes to `jackie-device`** with the memory
  context (its last 2,000 characters), and comes back with Jackie's system
  prompt. That is the only network call an on-device answer makes.

That last request is why on-device is not offline. Jackie's persona is kept out
of the browser bundle so that loading the app does not hand it to anyone who
asks, so the tab cannot build it alone. `jackie-device` builds it with the same
guard every other engine uses (`_shared/personaGuard.ts`: persona, the owner's
morals, the context) and records the attestation, so the morals page lists
`jackie-device` with the other engines. It is owner-only, like `jacky-proxy` and
`jackie-ollama`, and spends no quota; another account gets a refusal that says
why. If the prompt cannot be fetched, the device does not answer — it does not
answer as an anonymous assistant instead (rule 6).

## Not in the fallback chain

On-device answers only when chosen, and nothing answers in its place. A failure
— not downloaded, the persona unreachable, the model writing nothing — is
reported, and the question is not passed to a cloud engine, which is exactly
where someone who chose On-device did not want it to go. No server engine falls
back to it either.

## How fast

It depends almost entirely on whether the browser has a GPU it will lend to
WebGPU. llama.cpp offloads every layer to WebGPU when it can and runs on the CPU
when it cannot; the panel says which.

The only measurements so far come from the cloud container this was built in,
which has no GPU and a slow CPU, so they are a floor, not an estimate:

| Run (headless Chromium, no GPU) | Time |
| --- | --- |
| Download from the app's own origin (local) | ~3 s |
| First answer with Jackie's full persona (1,229 prompt tokens, 64 out), wllama called directly, single thread | 12 min 3 s |
| Next answer in the same session (1,225 of 1,313 tokens reused from the cache) | 76 s |
| Same two, through WebGPU on SwiftShader (a software GPU, so also the CPU) | 12 min 37 s, then 85 s |
| `bonsaiDevice.ts` end to end in Chromium: download from the app's origin, then a one-line system prompt and "What is 2 + 2?" (39 prompt tokens) | download 2.5 s; first token 52 s, including loading the model; answer "2 + 2 = 4." at 60 s |

On a laptop or phone with a real GPU, prompt reading is many times faster; that
has not been measured here. Multi-threading would also help on the CPU, but it
needs the page to be cross-origin isolated (COOP/COEP headers). The app does
not set them: isolation blocks every cross-origin resource that has not opted
in, and what that would break elsewhere in the app has not been checked.

## Limits

- **Window:** 4,096 tokens, about 460 MB of memory on top of the 237 MB model.
  Jackie's persona, morals and the memory context take roughly half; the oldest
  turns of a long conversation are dropped first, and the question being asked
  never is. A message that cannot fit beside the persona is refused with a
  reason rather than cut.
- **Answers** stop at 512 tokens.
- **One question at a time.** A second send waits for the first, and so does
  a Guide question asked while the chat is answering: they share the model.
- **Thinking off.** Bonsai's Qwen-family template thinks aloud first unless
  told not to; at CPU speed that is minutes of tokens nobody sees.
- wllama would otherwise fetch a "compat" build from `cdn.jsdelivr.net` for
  browsers without JSPI or 64-bit memory. That is turned off
  (`wllamaRuntime.ts`): third-party code would run beside Jackie's persona and
  memory. Those browsers are told they cannot run Bonsai instead.

## Deploying it

No migration and no secret. Deploy the new function, `jackie-device`, with the
others; the browser half ships with the app. Until the function is deployed,
an on-device answer fails with "Jackie's persona could not be fetched".

## Files

| File | What |
| --- | --- |
| `src/lib/microai/bonsaiDevice.ts` | Pins, source resolution, download, status, remove, the streamed answer |
| `src/lib/microai/wllamaRuntime.ts` | Starting wllama: lazy, same-origin, no CDN |
| `src/components/microai/BonsaiDevicePanel.tsx` | The download / progress / remove panel |
| `src/lib/jackie-engines.ts`, `src/lib/jackie-router.ts` | The `device` engine and its turn |
| `supabase/functions/jackie-device/` | Jackie's guarded system prompt for the device |
| `src/test/jackie-device.test.ts` | Pins, sources, window fitting, streaming, routing |
