/**
 * Calling this project's edge functions.
 *
 * There is one way to get these headers wrong and it is the way everyone got
 * them wrong: sending the publishable key as a bearer token.
 *
 * This project's key is the new opaque kind (`sb_publishable_…`), not a JWT.
 * The generated Supabase client already knows that — `createSupabaseFetch` in
 * `integrations/supabase/client.ts` deliberately *deletes* an Authorization
 * header holding that key and sends it as `apikey` instead. But every
 * hand-written `fetch` to a function bypassed the client and did the forbidden
 * thing, with no `apikey` at all. The gateway rejects that before the function
 * runs, and the browser reports the rejection as `TypeError: Failed to fetch` —
 * a message that names neither the cause nor the fix, which is how the chat sat
 * broken behind an error nobody could act on.
 *
 * So the rules, in one place:
 *
 * - `apikey` always carries the publishable key. That is what it is for.
 * - `Authorization` carries the signed-in user's access token, because the
 *   functions read it: `jackie-chat` calls `supabase.auth.getClaims(token)` and
 *   answers 401 to anything that is not a real user JWT.
 * - No session means no Authorization header, and a caller that needs one is
 *   told it is not signed in rather than being sent to fail at the gateway.
 */
import { supabase } from "@/integrations/supabase/client";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** Full URL of an edge function, always on the configured project. */
export function edgeUrl(name: string): string {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/** Thrown when a function needs a signed-in user and there is not one. */
export class NotSignedInError extends Error {
  constructor() {
    super("You are signed out, so Jackie cannot answer. Sign in and try again.");
    this.name = "NotSignedInError";
  }
}

export interface EdgeHeaderOptions {
  /** Refuse rather than send an unauthenticated request. Default true. */
  requireSession?: boolean;
  extra?: Record<string, string>;
  /** Lets a caller cancel a request in flight — a streaming chat needs it. */
  signal?: AbortSignal;
}

export async function edgeHeaders({
  requireSession = true,
  extra,
}: EdgeHeaderOptions = {}): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token && requireSession) throw new NotSignedInError();

  return {
    "Content-Type": "application/json",
    apikey: PUBLISHABLE_KEY,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * POSTs to an edge function with headers it will actually accept.
 *
 * Returns the raw Response so streaming callers can read the body themselves.
 */
export async function callEdgeFunction(
  name: string,
  body: unknown,
  options: EdgeHeaderOptions = {},
): Promise<Response> {
  return fetch(edgeUrl(name), {
    method: "POST",
    headers: await edgeHeaders(options),
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

/**
 * Turns a failure into something a person can act on.
 *
 * `fetch` rejects with a bare "Failed to fetch" for every network-level
 * problem — offline, DNS, a gateway that refused before CORS. Passing that
 * string to the user, which is what the chat did, tells them nothing at all.
 */
export function describeEdgeFailure(error: unknown, name: string): string {
  if (error instanceof NotSignedInError) return error.message;
  const message = error instanceof Error ? error.message : String(error);

  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return typeof navigator !== "undefined" && navigator.onLine === false
      ? "You are offline, so Jackie cannot reach the server. This part needs a connection."
      : `Could not reach the ${name} function. Check that it is deployed to this project and that you are online.`;
  }
  return message;
}
