# The chat pipeline, and why it was silent

Jackie's main chat runs through four pieces:

```
src/pages/Index.tsx          the surface — history, memory, attachments, stop
  └─ src/lib/jackie-stream.ts   reads the SSE stream, decides success or failure
       └─ src/lib/edgeFunction.ts   builds headers the gateway will accept
            └─ supabase/functions/jackie-chat/   auth, validation, model gateway
```

Two shared modules sit under `supabase/functions/_shared/` and are imported by
both sides, so there is no second copy to drift:

- `authGate.ts` — verifies the caller's access token.
- `chatRequest.ts` — the model list, message validation, the context budget.

## What was broken

`jackie-chat` opened with `supabase.auth.getClaims(token)` against a client
pinned to `@supabase/supabase-js@2.49.1`.

`getClaims` was added in **2.50.0**. At 2.49.1 it is `undefined`.

So the gate was not rejecting requests — it was throwing
`TypeError: ... is not a function` before authentication was attempted at all,
on every request. That throw happened *outside* the request's `try/catch`, so
the isolate answered 500 with **no CORS headers**. A browser is not allowed to
read such a response, so what reached the user was:

```
TypeError: Failed to fetch
```

which names neither the pin nor anything a person could act on. Twenty-one
functions had the same line, including `jacky-proxy` — the bridge to the real
Jacky engine — so the telemetry and the squads were down for the same reason.

## What holds it up now

- The pin is 2.58.0 wherever `getClaims` is used, and
  `src/test/chat-request.test.ts` walks every deployed function to keep it
  there.
- `verifyAccessToken` falls back to `getUser`, which has existed for the whole
  v2 line, whenever `getClaims` is missing or throws. A version skew now costs
  a round trip, not the product.
- It never throws. Every path returns a verdict, and every answer from
  `jackie-chat` carries CORS headers — a 401 the browser cannot read is
  indistinguishable from the server being down.

## The failures that looked like answers

Fixing the crash exposed three quieter ones, all of which rendered as an empty
assistant bubble:

| Failure | Was | Now |
| --- | --- | --- |
| Gateway reports an error inside a 200 stream | dropped; `onDone` called | reported with the gateway's own words |
| Model stops on its content filter | dropped | said plainly |
| Stream carries no content at all | saved as an empty message | an error naming it |
| Memory + tasks + files outgrow the prompt budget | every request failed | context clamped, tail kept |
| A model id from an older build | server silently used its own default | resolved against the shared list |

`src/test/jackie-stream.test.ts` covers each one.

## Stopping an answer

The composer's Send becomes Stop while an answer is streaming. Stopping is a
third outcome: `streamChat` calls neither `onDone` nor `onError`, and whatever
already arrived is kept and saved rather than thrown away.

## If the chat is quiet again

The message on screen now names the cause. The ones worth knowing:

- *"Jackie has no model key"* — set the `LOVABLE_API_KEY` secret on the project.
- *"Jackie's model key was refused"* — the key is set but the gateway rejected it.
- *"Your session expired"* — sign in again.
- *"Server auth is not configured"* — `SUPABASE_URL` / `SUPABASE_ANON_KEY` are
  missing from the function's environment.
- *"Could not reach the jackie-chat function"* — it is not deployed to this
  project, or the browser is offline.
