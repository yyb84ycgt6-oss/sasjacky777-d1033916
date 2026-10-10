# Jackie's morals and the guard rail

`/morals` (owner only) is where the owner sets what Jackie holds to, and where
they can see what the system is actually doing and whether anything changed
that they did not approve.

## The pieces

| Piece | Where | What it does |
| --- | --- | --- |
| Morals | `jackie_morals` table | Up to 24 short rules. Owner-only by RLS. |
| Morals block | `_shared/morals.ts` | Turns the enabled morals into the text added to Jackie's persona. Shared by the engines and the browser, so both compute the same fingerprint. |
| The guard | `_shared/personaGuard.ts` | Every engine builds its system prompt here: persona + morals (read server-side with the service role, never from the request), and records an attestation of what it ran. |
| Ledger | `jackie_morals_ledger` | Every change to a moral, from any path, plus every seal. Written only by a trigger; append-only even for the service role; each entry hashes the one before it. |
| Attestations | `jackie_persona_attestations` | One row per distinct setup each engine has run with: persona fingerprint, morals fingerprint, or `override` when a caller sent its own system prompt. |
| Status and seal | `functions/jackie-morals` | Owner-only. Returns the live persona text and fingerprint; seals the current persona and morals into the ledger. The browser never says what is sealed. |
| The page | `src/pages/JackieMorals.tsx`, `src/lib/jackie-morals.ts` | Re-verifies the whole chain in the browser, keeps a witness of the last head it verified, and turns everything into checks. |

## What each check means

- **Change history**: the chain verifies. A break names the first entry that does not.
- **This browser's memory**: the history still contains the last entry this browser verified. A history that verifies but no longer contains it was rewritten.
- **Changes made outside the app**: an entry with no account behind it, which means the service role, the SQL editor or a migration made the change.
- **Your seal / persona / morals**: the live persona and morals against what was last sealed. The persona comes from code, so a deploy that changes it shows here, and the Persona tab shows the diff.
- **Engines**: what each engine reported running on its latest request. Red for answering without the morals, or with a persona nobody sealed. Requests that carried their own system prompt (Agent Lab, operators, `jackie-orchestrate`) are counted, because the morals are not added to those.

## What it cannot see

- Someone with full database access can disable the triggers and write a new chain that verifies. The witness catches that only in a browser that looked before the rewrite.
- Code that reports a false fingerprint about itself cannot be caught from inside the app. Git history and CI are the anchor for code, and `src/test/jackie-morals.test.ts` fails if an engine stops going through the guard.
- Agents with their own system prompt do not get the morals. Adding prose to a prompt that must answer in strict JSON breaks the agent. They are counted instead.

## Switching it on

The migration does not run itself:

```bash
supabase db push            # 20261010120000_jackie_morals_guard_rail.sql
# deploy functions (Lovable does this), then regenerate types if you want them typed:
supabase gen types typescript --linked > src/integrations/supabase/types.ts
```

Until then the page says it is not set up, and every engine answers on the base
persona and records `persona-without-morals` once the attestation table exists.
Then open `/morals`, add morals (or the suggested set), review the Persona tab,
and **Seal**. Everything after is measured from that seal.

## Rules for changing it

- No agent surface (`appActions.ts`, `appAgent*.ts`, `src/lib/mcp/`) may read or write the morals. An agent that can edit the rules binding it makes them suggestions. A test enforces this.
- A new engine that answers in Jackie's name calls `guardedSystemPrompt` and is added to `PERSONA_ENGINES`. A test walks `supabase/functions` and fails if the two disagree.
- The ledger hash is `sha256(prev_hash \n seq \n action \n payload)` in both SQL and the browser. `src/test/fixtures/morals-ledger.golden.json` was written by PostgreSQL and pins them together.
