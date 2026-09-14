# Authorization hardening — what changed, and what to do with it

This covers the P0/P1 findings from the security review. Everything below was
verified by replaying the real migration chain against PostgreSQL 16 and
attempting each cross-tenant move as a second signed-in user
(`scripts/db-authz-test.sh`, 21 probe groups).

## Deploy in this order

The migration must land before the functions. Two of the functions call RPCs it
creates, and one of them depends on grants it revokes.

```
supabase db push                      # 20260914120000 + 20260914120100
supabase functions deploy api-key-auth --no-verify-jwt
supabase functions deploy api-keys jackie-openrouter jackie-xai-media \
                          jackie-ollama core-claim mcp
supabase functions deploy             # the remaining provider functions
```

Then regenerate the client types, which are behind the schema:

```
supabase gen types typescript --linked > src/integrations/supabase/types.ts
```

## Two things will change behaviour immediately

**Bots must move to the new endpoint.** `POST /api-keys/authenticate` now
answers `410` and names `api-key-auth`. It never actually worked — the function
required a Supabase user session before dispatching, which a bot holding only
an API key does not have — so nothing in production can be depending on it. Any
bot code written against it needs repointing:

```
POST /functions/v1/api-key-auth
Authorization: Bearer sk_live_...
```

**Provider calls are now metered.** Defaults are 20/minute and 1000/day per
user, applied before any upstream request. Raise, lower or disable per account:

```sql
insert into public.provider_quota_policy (user_id, per_minute, per_day)
values ('<uuid>', 120, 20000)
on conflict (user_id) do update
  set per_minute = excluded.per_minute, per_day = excluded.per_day;
```

Model allowlists are overridable without a redeploy, via
`OPENROUTER_MODEL_ALLOWLIST`, `XAI_RESPONSE_MODEL_ALLOWLIST` and
`OLLAMA_MODEL_ALLOWLIST` (comma-separated). An unset or empty value keeps the
built-in list rather than allowing everything.

## Findings the review did not have

Three things turned up that were not in the report, all of which the static
read could not have reached:

**`20260817181911` has never applied.** It moves the role helpers out of the
API-exposed schema and deletes `claim_core_access()` — a `SECURITY DEFINER`
function with `EXECUTE` granted to `authenticated` that writes the caller an
`owner` row. It repoints seven policies onto `private.has_role` and misses an
eighth, the `read own or audit all` policy on `audit_events` added a week
earlier, so its `DROP FUNCTION` fails on a dependency every time. Whether the
runner wrapped it in a transaction only decides which way it failed; either way
`claim_core_access()`, `public.has_role()` and `public.is_admin()` are still
live and callable over the Data API. `20260914120100` completes it.

**Keys were mintable from the browser.** `GunitApiKeys.tsx` generated a key
client-side and inserted the row over PostgREST. RLS pinned `user_id`, so no
one could forge a key for someone else — but the client chose `rate_limit`, and
it could set `expires_at` and `superseded_by`, the two columns rotation depends
on. A caller-chosen rate limit is not a rate limit, which would have made the
new limiter decorative. Write grants on `api_keys` are revoked and that panel
now calls the edge function.

**The sticky-note leak had a second path.** Notes are also written to
`FilingSystem`, which used one fixed `jackie.filing.` prefix for notes, pods,
agents and tasks alike — so namespacing only the notes key would have left the
same records readable across accounts on a shared browser.

## Findings that turned out not to be problems

Worth recording so nobody spends a cycle on them again. The review flagged
these as unverifiable and treated `mcp` as high severity on that basis; the
migration SQL says otherwise.

- **`user_roles` is already correct.** `INSERT`/`UPDATE`/`DELETE` require
  `is_admin()` with no `auth.uid() = user_id` escape, so a user cannot grant
  themselves a role. The helpers were meant to be non-exposed, which is what
  `20260914120100` finally achieves.
- **Every user table is already owner-scoped.** `jackie_tasks`,
  `jackie_memory`, `conversations`, `chat_messages`, `chat_attachments` and
  `user_bots` all have owner-only CRUD, and storage objects are bound to
  `auth.uid()` by path. The `USING (true)` policies on `conversations` and
  `chat_messages` were dropped in `20260326230832`.
- **`mcp` was therefore not a live cross-tenant hole.** It builds a user-scoped
  client, so RLS is the boundary and RLS is right. The explicit `user_id`
  predicates added here are defence in depth, and worth having on an endpoint an
  agent will drive with every id it has seen — but this was not a `🔴`.

## Still open

- **Generated Supabase types are behind the schema.** `user_roles` and
  `user_bots` are missing, and `ApiKeyManager` casts around it. Run
  `supabase gen types` against the live project — it needs credentials this work
  did not have — and drop the `as any`.
- **No e2e specs exist.** The Playwright config referenced a package that was
  never installed, so the suite has never run. The config works now; `e2e/README.md`
  names the three specs worth writing first.
- **The migration chain is not cleanly replayable.** Besides `20260817181911`,
  `20260817180014` re-creates `user_roles`/`app_role` already made by
  `20260807073000`. `scripts/db-authz-test.sh` tolerates both by name. A fresh
  environment cannot be provisioned from `supabase/migrations/` until they are
  reconciled — worth fixing before anyone needs a preview database.
- **Untouched, from the review:** route-level lazy loading, the ~250 MB of model
  assets, incremental TypeScript strictness, rejecting `sb_secret_` keys in
  browser builds, `/hub` being explicitly rather than accidentally public, and
  the TonConnect wallet TODO. All real; none of them are authorization.
- **CORS is still `*`.** Ranked low deliberately: every endpoint requires a
  bearer token, and another origin does not obtain one by being allowed to ask.
