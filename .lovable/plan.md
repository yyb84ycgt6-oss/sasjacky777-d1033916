# Router Mesh — Minimal Lovable Surface

Goal: Lovable holds the smallest possible contract (registry + job queue + logs). Every router node — Pi, old phone, VPS, browser tab, ESP32, whatever — is yours to build, break, and learn from.

## Division of labor

```text
  YOUR TERRITORY (learn here)          LOVABLE (thin meeting point)
  ────────────────────────────         ────────────────────────────
  Router nodes (any language)   ◄──►   /router-poll   claim a job
  HTTP polling or webhook       ◄──►   /router-result post the answer
  Talks to AI provider          ◄──►   /router-register  self-register
  Retries, auth, scraping,             Registry table, jobs table, logs
  local models, whatever
```

Lovable never talks to an AI provider on the router path. It only holds jobs and hands them out. You own everything past the endpoint.

## What gets built on Lovable

### 1. Two tables
- `mesh_routers` — id, user_id, name, shared_secret_hash, capabilities (text[], e.g. `['groq','ollama:qwen','chatgpt-web']`), last_seen_at, status
- `mesh_jobs` — id, user_id, router_id (nullable), prompt, capability_required, status (`queued|claimed|done|failed`), result, created_at, claimed_at, finished_at

Both RLS-scoped to `auth.uid()`. Standard GRANTs.

### 2. Three edge functions (all tiny, all documented)
- `router-register` → POST name + capabilities → returns router_id + shared_secret (shown once). You write this secret into your Pi/phone script.
- `router-poll` → router sends `{router_id, secret, capabilities}` → returns oldest matching queued job or `null`. Marks it `claimed`.
- `router-result` → router sends `{router_id, secret, job_id, result | error}` → writes to `mesh_jobs`.

That's it. No provider logic, no scraping code, no model calls on Lovable's side.

### 3. One UI page `/mesh`
- **Routers tab**: list your registered routers, last-seen heartbeat, capability tags, revoke button.
- **Register button**: opens a modal, you name the router + pick capabilities, it shows the secret + a copy-pasteable curl example so you can immediately test from any terminal.
- **Jobs tab**: submit a test job (prompt + required capability), watch it flip queued → claimed → done, see which router took it and what it returned.
- **Logs tab**: last 200 jobs with timings.

### 4. Docs page `/mesh/docs`
Plain markdown inside the app showing:
- The 3 endpoint contracts (request/response JSON)
- A ~30-line Python polling example
- A ~30-line Node polling example
- A bash/curl one-liner example
- Note that Telegram bot can push results back to your phone if you want (uses the token you already saved)

No SDK, no wrapper. Raw HTTP so you actually learn the protocol.

## What is explicitly NOT built
- No Lovable-side scraper, no Playwright, no provider fallback on the mesh path (your existing `/providers` fallback chain stays separate and untouched).
- No auto-generated router code shipped as a binary. Examples only — you write your own.
- No forced router runtime. Python, Node, Go, Rust, a shell script, an Arduino — any of them can hit three HTTP endpoints.

## Security boundary
- Each router has its own secret, hashed at rest, verified per request.
- All jobs scoped by `user_id`; a router can only claim jobs belonging to its owner.
- Rate limit poll to 1/sec per router (soft, in-function).

## Why this shape
- **You learn the hard parts** (transport, auth flows, scraping, model hosting, retries) on hardware you own.
- **Lovable does the boring part** (a queue with auth and a UI) so you're not rebuilding CRUD every time you try a new router idea.
- **Nothing here locks you in** — the contract is 3 HTTP endpoints. If you ever leave Lovable, you replace them with 40 lines of Fastify and your routers keep working.

## Out of scope for this plan
- Building the actual router nodes (that's your workshop).
- Any scraping of chatgpt.com / claude.ai (legal + fragility issue — your call, your box).
- Changing the existing `/providers` fallback chain.

## Deliverable
Two tables, three edge functions, one `/mesh` page with 3 tabs, one `/mesh/docs` page with copy-pasteable examples in 3 languages. Nothing more.
