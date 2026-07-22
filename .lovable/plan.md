# Seed Pods + Micro-Routers — Bridge Layer

Connect the three pieces that already exist (`/eyepod`, `/mesh`, `/providers`) into the vision: **color-coded QR seeds, pod-bound routers, lazy decompression, and Y-axis folding**.

Nothing gets rebuilt. Only bridges are added.

## What gets added

### 1. Seed identity (colors + QR)
Every eYe pod gets:
- `color` (from a fixed 24-color palette, one per pod slot)
- `glyph` (single emoji/symbol)
- `capability` string (e.g. `seed:security`, `seed:code`, `seed:memory`)
- `version` + `content_hash` (SHA-256 of the compressed blob)

A **Seed Card** UI on `/eyepod` shows each pod as a colored tile with its glyph and a **QR button**. The QR encodes:
```json
{ "pod_id": "...", "version": 3, "capability": "seed:security",
  "hash": "sha256:...", "url": "<supabase-url>/functions/v1/pod-fetch" }
```
Scanning it on another device (or from a router node) is enough to pull + verify that exact seed. No secrets in the QR — read-only pod fetch is gated by the scanner's own auth.

### 2. Pod-bound routers
`mesh_routers` gets a nullable `pod_id` column. A router registered with a `pod_id`:
- Only receives jobs whose `capability_required` matches that pod's capability.
- Reports pod version on every poll; if the server has a newer version, the poll response includes `{seed_update: {url, hash}}` so the router can pull the new seed before continuing.

This is your "router knows the application" — the pod IS the application slice it knows.

### 3. Lazy / streaming decompression
`src/lib/eye-pods.ts` gains `openSlice(podId, path)` — decompress only a JSON path (e.g. `openSlice("security", "rules.mitre.T1078")`), leaving the rest sealed. Uses the existing LZ blob but decompresses in a chunked worker so a big pod doesn't freeze the tab. Speed is capped by a `bytesPerTick` knob (adjustable — your "slow speed as to not fault hardware").

### 4. Y-axis fold (surface → circle with infinite points)
New edge function `pod-fold`:
- Input: a slice of pod content (text)
- Output: `{ vector: number[768], hash, glyph, color }`
- Uses Lovable AI embeddings (`google/gemini-embedding-001`, truncated to 768 dims via OpenAI's `text-embedding-3-small` when the caller wants the smaller footprint — chosen by pod, not hardcoded).
- Storage: new `pod_folds` table with `pgvector` column so a router can drop its folded slice into a shared searchable surface.
- What this means concretely: a router reads 20 KB of pod text, folds it to a 3 KB vector + hash, ships THAT back to Lovable. The full text never leaves the pod. Anyone querying similarity gets a hit + the hash + which pod/router owns it — decrypt is a separate step gated by the pod's own auth.

### 5. Merge surface (`/eyepod/surface`)
A visual page: every folded vector plotted as a point on a unit circle (2D projection via t-SNE-lite in browser), colored by source pod. Clicking a point shows `{pod, capability, hash, router_that_folded_it, timestamp}`. This is the "circle with infinite points" you described — the merged surface of all folded knowledge.

## Data model additions

```text
mesh_routers    + pod_id (uuid, nullable, references eye_pods.id)
eye_pods        + color, glyph, capability, version, content_hash
                (or if eye_pods lives only in IndexedDB today,
                 add a lightweight `eye_pod_registry` mirror table
                 for QR / router lookup — decision noted below)
pod_folds       (new): id, user_id, pod_id, router_id, capability,
                vector(768), hash, source_ref, created_at
                + pgvector hnsw index
```

## New edge functions
- `pod-fetch` — auth'd, returns a pod blob by id + verifies hash
- `pod-fold` — embeds a slice, inserts into `pod_folds`
- `pod-search` — cosine search over `pod_folds`, returns hits + hashes

## UI changes
- `/eyepod`: swap tile grid for **Seed Cards** with color, glyph, QR button, capability tag, size, version.
- `/mesh`: registration modal gains a "Bind to seed pod" dropdown; router cards show their pod chip.
- `/eyepod/surface`: new page with the merged fold circle.

## Open decision (need your call before building)
**Where does the pod registry live?** Right now pods are IndexedDB-only (per-device). QR + pod-bound routers need a small server-side registry so a scanned QR resolves on any device.

Two options:
- **A. Add `eye_pod_registry` server table** — metadata only (id, color, glyph, capability, version, hash, size). Blob still lives in IndexedDB + optional Supabase storage bucket for cross-device sync. Cleanest, unlocks the full vision.
- **B. Keep pods device-local** — QR encodes the blob itself (limits pod size to ~2KB; kills the vision for anything real).

Recommendation: **A**.

## Explicitly out of scope
- No changes to `/providers`, `/control`, Jackie chat, or the existing router mesh contract (3 endpoints stay identical — pod-binding is additive).
- No new AI provider. Folding uses the Lovable AI embeddings you already have.
- No proprietary encryption scheme invented. Cipher = AES-GCM with per-pod key derived from user session; hash = SHA-256. Standard, auditable.

## Deliverable when built
Colored seed tiles with QR export → scan on another device or feed to a router → that router only wakes for its pod's capability → folds slices to vectors → the merged surface page shows the whole knowledge circle growing in real time.

**Confirm option A vs B, and I'll build it.**
