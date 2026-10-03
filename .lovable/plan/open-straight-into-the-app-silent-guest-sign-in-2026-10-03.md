# Open straight into the app: silent guest sign-in

## What you'll see
- No login screen. Opening any page goes straight into Jackie.
- Behind the scenes, each browser quietly gets its own private guest account. Chat, memory, tasks and saving keep working.
- Your data and other visitors' data stay walled off from each other. Nothing is deleted. You said "eliminate data user" was meant as a safety precaution, so keeping these walls is how that's covered.
- Your owner-only tools (your own rig engine, GitHub sync, core docs) stay locked to your real account. A guest visitor can't reach your hardware or private files.
- AI answers start working again. Right now every AI request is refused because a usage-limit setup step was never applied to the database.

## Steps
1. **Turn on guest accounts** in the sign-in settings. The app already has a "demo" button that uses them, but the setting is off.
2. **Sign in silently.** When someone opens a page with no account, the app creates a guest account in the background and continues. If that fails, it shows a plain message saying why instead of a blank screen.
3. **Leave the sign-in page reachable but unlinked.** You can still go to it directly to use your owner account.
4. **Apply the missing usage-limit setup.** This uses the two files already in your project, unchanged. Guests get the same fair usage cap that is already defined there, so a stranger can't run up your AI bill.
5. **Test before handing back.** Open the home chat, the Repair Consultant, `/micro` and `/triage` in a fresh browser. Confirm each loads without a login screen and that one real AI answer comes back. Report anything that still fails, by name.

## Technical details
- Change the `ProtectedRoute` in `App.tsx`: when `!user && !loading`, call `supabase.auth.signInAnonymously()` once (guarded by a ref) and render a loading state, not `<Auth />`. On error, render the reason.
- Enable anonymous sign-ins with `configure_auth`. Leave email auto-confirm alone.
- Run `20260914120000_authz_hardening.sql` then `20260922120000_provider_quota_lock.sql` through the migration tool, byte-for-byte. First check which of the other migrations are also unapplied, and apply only what `consume_provider_quota` depends on.
- Leave RLS on every table as it is. Owner-only functions still check the `owner` role.
- Verify with Playwright on a fresh context: `/`, `/repair`, `/micro`, `/triage`. Send one prompt through `jackie-chat` and one through `build-triage`.

## Risk
- An anonymous guest loses their history if they clear browser data. That's fine for a demo.
- If the database setup step fails, I'll report the exact error and won't hide it.
