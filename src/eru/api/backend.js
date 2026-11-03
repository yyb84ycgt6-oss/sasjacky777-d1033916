/**
 * Eru's backend client. It connects to nothing.
 *
 * Every Eru screen talks to this one object. It used to wrap a hosted
 * platform's SDK, which went live whenever one environment variable was set.
 * This file imports no SDK and reads no environment variable, so there is no
 * switch left that can turn a remote backend on. A future backend the owner
 * chooses plugs in here, in one file, and nowhere else.
 *
 * What each kind of call does, and why:
 *
 *   Reads (list, filter, find, get, read)  -> empty results.
 *     Pages already render empty states for these. Nothing is invented.
 *
 *   Writes (create, update, delete, bulkCreate), server calls
 *   (functions.invoke), AI and uploads (integrations.*), connectors, and
 *   account changes  -> reject with BackendNotConnectedError.
 *     The stand-in this replaces resolved writes with nothing, so a form
 *     closed as if it had saved and the data was silently gone. Saying
 *     "not saved" is the honest answer when nothing was saved.
 *
 *   Live updates (subscribe)  -> a working unsubscribe function, no events.
 *     The old stand-in returned a promise here, which crashed every screen
 *     that called unsubscribe() on the way out.
 *
 *   Sign-in  -> the owner's own Supabase session, as before. Supabase is the
 *     backend the owner set up for this app; it is read, never replaced.
 *
 * Nothing in here can make a promise that never settles: proxies answer
 * `then` with undefined, so `await backend.entities.X` resolves instead of
 * hanging forever.
 */

export class BackendNotConnectedError extends Error {
  constructor(operation) {
    super(`Not saved: no backend is connected (${operation}). This build runs offline.`);
    this.name = 'BackendNotConnectedError';
    this.operation = operation;
  }
}

export function isBackendNotConnected(error) {
  return Boolean(error) && error.name === 'BackendNotConnectedError';
}

const READ_EMPTY = new Set(['list', 'filter', 'find']);
const READ_ONE = new Set(['get', 'read']);

const refuse = (operation) => async () => {
  throw new BackendNotConnectedError(operation);
};

// Property names a proxy must not answer. `then` would make the proxy look
// like a promise to `await`; symbols are asked for by inspection and
// serialisation, and answering them with a function breaks both.
function isReserved(name) {
  return typeof name === 'symbol' || name === 'then' || name === 'toJSON';
}

function entityTable(entity) {
  return new Proxy(
    {},
    {
      get(_target, op) {
        if (isReserved(op)) return undefined;
        if (READ_EMPTY.has(op)) return async () => [];
        if (READ_ONE.has(op)) return async () => null;
        if (op === 'subscribe') return () => () => {};
        return refuse(`entities.${entity}.${String(op)}`);
      },
    },
  );
}

/** A namespace where every call, at any depth, is refused by name. */
function refusingNamespace(path) {
  return new Proxy(function refused() {}, {
    get(_target, name) {
      if (isReserved(name)) return undefined;
      return refusingNamespace(`${path}.${String(name)}`);
    },
    apply() {
      return Promise.reject(new BackendNotConnectedError(path));
    },
  });
}

/**
 * Builds the client. `getUser` is the sign-in boundary — the app passes its
 * Supabase session, tests pass a stub — so the rest of this runs for real in
 * both.
 */
export function createOfflineBackend({ getUser, goToSignIn, signOut }) {
  const entities = new Proxy(
    {},
    {
      get(_target, entity) {
        if (isReserved(entity)) return undefined;
        return entityTable(String(entity));
      },
    },
  );

  const auth = {
    me: getUser,
    isAuthenticated: async () => Boolean(await getUser()),
    logout: signOut,
    login: async () => goToSignIn(),
    redirectToLogin: async () => goToSignIn(),
    loginWithProvider: async () => goToSignIn(),
    // Setting a token for a backend that does not exist changes nothing and
    // reports nothing, so a no-op here is not a fake result.
    setToken: () => undefined,
    updateMe: refuse('auth.updateMe'),
    register: refuse('auth.register'),
    loginViaEmailPassword: refuse('auth.loginViaEmailPassword'),
    verifyOtp: refuse('auth.verifyOtp'),
    resendOtp: refuse('auth.resendOtp'),
    resetPassword: refuse('auth.resetPassword'),
    resetPasswordRequest: refuse('auth.resetPasswordRequest'),
  };

  return {
    entities,
    auth,
    functions: {
      invoke: async (name) => {
        throw new BackendNotConnectedError(`functions.invoke("${String(name)}")`);
      },
    },
    integrations: refusingNamespace('integrations'),
    connectors: refusingNamespace('connectors'),
    offline: true,
  };
}

/**
 * Tells the person when a save went nowhere and the screen did not say so.
 *
 * About a third of Eru's write sites have no error handling, so a refusal
 * there would otherwise surface only in the console. This listens for exactly
 * that case — an unhandled BackendNotConnectedError — and nothing else.
 * Errors a screen catches itself never reach it. Returns a function that
 * removes the listener.
 */
export function installBackendNotice(notify) {
  if (typeof window === 'undefined') return () => {};
  const onRejection = (event) => {
    if (!isBackendNotConnected(event.reason)) return;
    event.preventDefault();
    notify(event.reason);
  };
  window.addEventListener('unhandledrejection', onRejection);
  return () => window.removeEventListener('unhandledrejection', onRejection);
}
