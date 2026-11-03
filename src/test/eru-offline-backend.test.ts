import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BackendNotConnectedError,
  createOfflineBackend,
  installBackendNotice,
  isBackendNotConnected,
} from "@/eru/api/backend";

/**
 * Eru's backend client, driven for real. The only stub is the sign-in
 * boundary, which returns plain data.
 *
 * Each case below pins behaviour the old stand-in got wrong:
 *  - writes resolved with nothing, so a form closed as if it had saved;
 *  - `integrations.Core.InvokeLLM` was not a function (47 call sites crashed);
 *  - `subscribe` returned a promise, so unsubscribe() crashed on page exit;
 *  - a dozen auth methods did not exist at all.
 */
const user = { id: "u1", email: "owner@example.com" };

function make(getUser = async () => user) {
  const goToSignIn = vi.fn();
  const signOut = vi.fn(async () => {});
  const backend = createOfflineBackend({ getUser, goToSignIn, signOut });
  return { backend, goToSignIn, signOut };
}

describe("reads", () => {
  it("return empty, never invented data", async () => {
    const { backend } = make();
    expect(await backend.entities.Anything.list()).toEqual([]);
    expect(await backend.entities.Anything.filter({ a: 1 })).toEqual([]);
    expect(await backend.entities.Anything.find()).toEqual([]);
    expect(await backend.entities.Anything.get("id")).toBeNull();
    expect(await backend.entities.Anything.read("id")).toBeNull();
  });
});

describe("writes", () => {
  it("refuse with a named error instead of pretending to save", async () => {
    const { backend } = make();
    for (const op of ["create", "update", "delete", "bulkCreate"] as const) {
      const call = (backend.entities.BotAutomation as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
      await expect(call({ name: "x" })).rejects.toBeInstanceOf(BackendNotConnectedError);
    }
  });

  it("names the exact operation that was refused", async () => {
    const { backend } = make();
    await expect(backend.entities.BotAutomation.create({})).rejects.toMatchObject({
      operation: "entities.BotAutomation.create",
    });
  });

  it("refuses an operation it has never heard of, rather than resolving it", async () => {
    const { backend } = make();
    await expect(backend.entities.X.someNewOp()).rejects.toBeInstanceOf(BackendNotConnectedError);
  });
});

describe("server calls, AI, uploads and connectors", () => {
  it("refuse server functions by name", async () => {
    const { backend } = make();
    await expect(backend.functions.invoke("telegramWebhook", {})).rejects.toMatchObject({
      operation: 'functions.invoke("telegramWebhook")',
    });
  });

  it("refuse AI and upload calls, which used to crash with 'not a function'", async () => {
    const { backend } = make();
    await expect(backend.integrations.Core.InvokeLLM({ prompt: "hi" })).rejects.toMatchObject({
      operation: "integrations.Core.InvokeLLM",
    });
    await expect(backend.integrations.Core.UploadFile({})).rejects.toBeInstanceOf(
      BackendNotConnectedError,
    );
  });

  it("refuse connector calls, which used to crash on an undefined namespace", async () => {
    const { backend } = make();
    await expect(backend.connectors.connectAppUser()).rejects.toBeInstanceOf(BackendNotConnectedError);
    await expect(backend.connectors.disconnectAppUser()).rejects.toBeInstanceOf(
      BackendNotConnectedError,
    );
  });
});

describe("live updates", () => {
  it("hand back a working unsubscribe function, so leaving a page cannot crash", () => {
    const { backend } = make();
    const unsubscribe = backend.entities.AppNotification.subscribe(() => {});
    expect(typeof unsubscribe).toBe("function");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("never fire events, because nothing is listening on the other end", async () => {
    const { backend } = make();
    const handler = vi.fn();
    backend.entities.AppNotification.subscribe(handler);
    await new Promise((r) => setTimeout(r, 5));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("sign-in", () => {
  it("reports the owner's own session", async () => {
    const { backend } = make();
    expect(await backend.auth.me()).toEqual(user);
    expect(await backend.auth.isAuthenticated()).toBe(true);
  });

  it("reports signed out when there is no session", async () => {
    const { backend } = make(async () => null);
    expect(await backend.auth.me()).toBeNull();
    expect(await backend.auth.isAuthenticated()).toBe(false);
  });

  it("sends every sign-in entry point to the one sign-in page", async () => {
    const { backend, goToSignIn } = make();
    await backend.auth.login();
    await backend.auth.redirectToLogin();
    await backend.auth.loginWithProvider("google");
    expect(goToSignIn).toHaveBeenCalledTimes(3);
  });

  it("signs out through the owner's own session", async () => {
    const { backend, signOut } = make();
    await backend.auth.logout();
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("refuses account changes that have no backend to go to", async () => {
    const { backend } = make();
    for (const op of [
      "updateMe",
      "register",
      "loginViaEmailPassword",
      "verifyOtp",
      "resendOtp",
      "resetPassword",
      "resetPasswordRequest",
    ] as const) {
      await expect(backend.auth[op]({})).rejects.toMatchObject({ operation: `auth.${op}` });
    }
  });

  it("treats setToken as a no-op, which reports nothing and changes nothing", () => {
    const { backend } = make();
    expect(backend.auth.setToken("t")).toBeUndefined();
  });
});

describe("the proxies cannot hang a caller", () => {
  it("resolves an accidental await on a namespace instead of waiting forever", async () => {
    // A proxy that answered `then` would look like a promise and never settle.
    const { backend } = make();
    const results = await Promise.all([
      Promise.resolve(backend.entities),
      Promise.resolve(backend.entities.X),
      Promise.resolve(backend.integrations),
      Promise.resolve(backend.connectors.foo),
    ]);
    expect(results).toHaveLength(4);
  });
});

describe("installBackendNotice", () => {
  it("tells the person when an unhandled save went nowhere", () => {
    const notify = vi.fn();
    const remove = installBackendNotice(notify);

    // A real browser unhandledrejection event is cancelable.
    const event = new Event("unhandledrejection", { cancelable: true }) as Event & { reason: unknown };
    event.reason = new BackendNotConnectedError("entities.X.create");
    window.dispatchEvent(event);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    remove();
  });

  it("ignores every other kind of error", () => {
    const notify = vi.fn();
    const remove = installBackendNotice(notify);

    const event = new Event("unhandledrejection", { cancelable: true }) as Event & { reason: unknown };
    event.reason = new Error("something else");
    window.dispatchEvent(event);

    expect(notify).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    remove();
  });

  it("stops listening once removed", () => {
    const notify = vi.fn();
    installBackendNotice(notify)();

    const event = new Event("unhandledrejection") as Event & { reason: unknown };
    event.reason = new BackendNotConnectedError("entities.X.create");
    window.dispatchEvent(event);

    expect(notify).not.toHaveBeenCalled();
  });

  it("recognises the error by name, so a copy from another bundle still counts", () => {
    expect(isBackendNotConnected(new BackendNotConnectedError("x"))).toBe(true);
    expect(isBackendNotConnected({ name: "BackendNotConnectedError" })).toBe(true);
    expect(isBackendNotConnected(new Error("x"))).toBe(false);
    expect(isBackendNotConnected(null)).toBe(false);
  });
});

/**
 * The guarantee step 2 exists for: nothing in Eru's client layer can switch a
 * remote backend on. Asserted as an allowlist — the only import is the owner's
 * Supabase client — and no environment variable is read at all.
 */
describe("the client layer cannot go live", () => {
  const read = (file: string) =>
    readFileSync(path.resolve(__dirname, "../eru/api", file), "utf8");

  for (const file of ["backend.js", "base44Client.js"]) {
    it(`${file} imports nothing but the owner's Supabase client and its sibling`, () => {
      const imports = [...read(file).matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
      const allowed = new Set(["@/integrations/supabase/client", "./backend"]);
      const extra = imports.filter((spec) => !allowed.has(spec));
      expect(extra, `unexpected imports in ${file}: ${extra.join(", ")}`).toEqual([]);
    });

    it(`${file} reads no environment variable`, () => {
      expect(read(file)).not.toMatch(/import\.meta\.env|process\.env/);
    });
  }
});
