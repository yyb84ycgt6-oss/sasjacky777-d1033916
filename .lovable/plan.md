
# Lovable-First, Fallback-Everywhere AI Routing

## Intent
Lovable AI Gateway is the default brain of the app — always tried first, always pre-selected. Everywhere a model is called, the user (and Jackie herself, when auto-routing) can fall back to any other provider in a strict priority order: **free first, freemium next**. Nothing else about Jackie changes — memory, presets, archive, pods, and existing edge functions stay intact.

## Provider Priority (single source of truth)
Order used for defaults, auto-fallback, and UI listing:

1. **Lovable AI Gateway** — default, no key needed (Gemini 3 Flash default chat model)
2. **Groq** — free tier, needs `GROQ_API_KEY`
3. **OpenRouter :free models** — free tier, needs `OPENROUTER_API_KEY`
4. **Ollama / self-hosted** — free, needs `OLLAMA_BASE_URL`
5. **Google AI Studio (Gemini direct)** — free tier, needs `GOOGLE_AI_STUDIO_KEY` *(new)*
6. **Mistral La Plateforme** — free tier, needs `MISTRAL_API_KEY` *(new)*
7. **Cerebras** — free tier, needs `CEREBRAS_API_KEY` *(new)*
8. **Together AI** — freemium, needs `TOGETHER_API_KEY` *(new)*
9. **Hugging Face Inference** — freemium, needs `HF_TOKEN` *(new)*
10. **DeepInfra** — freemium, needs `DEEPINFRA_API_KEY` *(new)*
11. **Fireworks** — freemium, needs `FIREWORKS_API_KEY` *(new)*
12. **OpenAI / Anthropic / xAI direct** — paid, only if user adds keys *(new, opt-in)*

Each entry is a row in `src/lib/jackie-providers.ts` (existing file, extended — not rebuilt), marked `tier: "free" | "freemium" | "paid"` and `default: true` for Lovable.

## What Changes in the App

### 1. Universal `<ModelPicker/>` component
One shared React component used **everywhere a model is chosen** (Chat toolbar, Control Panel, Swarm builder, Bot Foundry, VeilOps, Sentinel, Providers page, Verify panel). It:
- Pre-selects Lovable AI + default Gemini model on first mount.
- Groups providers by tier (Free → Freemium → Paid) with Lovable pinned on top.
- Shows a key-status dot per provider (configured / missing) via `secrets--fetch_secrets` names only.
- "Fallback chain" toggle: when on, failed calls cascade through the priority list.

### 2. Auto-fallback in the client stream layer
`src/lib/jackie-provider-stream.ts` gains a `withFallback()` wrapper:
- Try selected provider.
- On 429/402/5xx or `provider_key_missing`, drop to next in priority list.
- Surface which provider actually answered (badge in the message meta).
- Preserve existing per-provider error surfacing.

### 3. New edge functions (thin, mirror existing pattern)
Same shape as `jackie-groq` / `jackie-openrouter`:
- `jackie-google` (Gemini direct)
- `jackie-mistral`
- `jackie-cerebras`
- `jackie-together`
- `jackie-hf`
- `jackie-deepinfra`
- `jackie-fireworks`

Each: JWT-gated, reads its own secret, OpenAI-compatible passthrough, streaming SSE. No orchestrator rewrite.

### 4. Providers page (`/providers`) upgrade
- Sectioned by tier.
- "Add key" button per provider that opens the `add_secret` flow with the correct env var name and help URL.
- Live test button already exists — kept.

### 5. Preset & orchestrator wiring
- Chat preset defaults to `{ provider: "lovable", model: "google/gemini-3-flash-preview" }` for new users.
- `jackie-orchestrator` model buckets (reasoning/coding/fast/long) list Lovable models first, then fall through the priority chain when a bucket's preferred key is missing.

## What Does NOT Change
- Memory system, pod system, archive/import, audit log, sidebar layout, colors, floating toolbar behavior.
- Existing edge functions keep their auth gates and logic.
- No provider is removed. No provider is auto-billed. Paid providers stay off unless the user pastes a key.

## Secrets Requested (only if user opts in per provider)
Handled via `add_secret` on demand from the Providers page — none requested up front.

## Files Touched
- `src/lib/jackie-providers.ts` — extend registry
- `src/lib/jackie-provider-stream.ts` — add fallback wrapper
- `src/lib/jackie-preset.ts` — Lovable as hard default
- `src/lib/jackie-orchestrator.ts` — priority-aware bucket resolution
- `src/components/ModelPicker.tsx` — new shared component
- `src/pages/AIProviders.tsx` — tier grouping + add-key buttons
- `src/components/DraggableToolbar.tsx`, Control Panel, Swarm, VeilOps AI bridge — swap in `<ModelPicker/>`
- `supabase/functions/jackie-{google,mistral,cerebras,together,hf,deepinfra,fireworks}/index.ts` — new

## Out of Scope (call out, don't do)
- Rewriting Base44/CYBERNETIC bridge.
- Any billing UI or usage meter beyond what Lovable already shows.
- Auto-provisioning paid keys.
