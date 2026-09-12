#!/usr/bin/env node
/**
 * Route smoke test.
 *
 * Opens every route the manifest declares in a real browser against a real
 * build and reports the ones that do not come up: a blank root, an uncaught
 * exception, a React error boundary catching a missing provider. Unit tests
 * cover the pieces; this covers the thing a person actually does — open the
 * page — which is how the Eru pages were able to ship for weeks rendering an
 * error card instead of a page.
 *
 *   npm run build
 *   npm run smoke                 # every route
 *   npm run smoke -- /eru/music   # just these
 *
 * It serves ./dist with the host attachment, drives Chromium through
 * Playwright, and exits non-zero if any route failed.
 *
 * Notes on what it does and does not claim:
 * - Most routes sit behind auth, so it seeds a throwaway Supabase session into
 *   the browser profile it just created. That token is local, expires, and is
 *   signed by nobody — it gets past the client-side guard so the page renders,
 *   and it buys no access to any server.
 * - Backend calls fail when the machine cannot reach Supabase. Those show up as
 *   "Failed to fetch" and are counted separately from app errors: a page that
 *   renders its empty state offline is working, a page that throws is not.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT || 4173);
const BASE = process.env.SMOKE_BASE || `http://127.0.0.1:${PORT}`;
const PROJECT_REF = (process.env.VITE_SUPABASE_PROJECT_ID
  || readEnvFile("VITE_SUPABASE_PROJECT_ID")
  || "").trim();

function readEnvFile(key) {
  try {
    const line = readFileSync(join(ROOT, ".env"), "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/** Route paths, read straight from the manifest so this cannot drift from the app. */
function allRoutes() {
  const core = readFileSync(join(ROOT, "src/lib/routeManifest.ts"), "utf8");
  const eru = readFileSync(join(ROOT, "src/eru/routes.generated.ts"), "utf8");
  const corePaths = [...core.matchAll(/\{ path: "([^"]*)"/g)].map((m) => m[1]);
  const eruPaths = [...eru.matchAll(/path: "([^"]*)"/g)].map((m) => (m[1] ? `/eru/${m[1]}` : "/eru"));
  // A route with a parameter still has to render, so give it a stand-in id
  // rather than skipping it — /eru/playlists/:id and friends broke exactly like
  // their parameterless neighbours did.
  const withSampleParams = (path) => path.replace(/:[^/]+/g, "smoke");
  return [...new Set([...corePaths, ...eruPaths].map(withSampleParams))].filter(Boolean);
}

const portOpen = (port) =>
  new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
      .on("connect", () => { socket.end(); resolve(true); })
      .on("error", () => resolve(false));
  });

async function startHost() {
  if (await portOpen(PORT)) return null;
  const child = spawn(process.execPath, [join(ROOT, "host/serve.mjs"), join(ROOT, "dist"), "--port", String(PORT)], {
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    if (await portOpen(PORT)) return child;
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`host did not come up on ${PORT}`);
}

/** A local, unsigned session so the client-side auth guard renders the page. */
function fakeSession() {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const id = "00000000-0000-4000-8000-000000000001";
  const claims = { sub: id, aud: "authenticated", role: "authenticated", email: "smoke@local", exp };
  return {
    access_token: `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.smoke`,
    refresh_token: "smoke",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: exp,
    user: {
      id, aud: "authenticated", role: "authenticated", email: "smoke@local",
      app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString(),
    },
  };
}

const NETWORK_NOISE = /Failed to fetch|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|Failed to load resource|net::/;

async function main() {
  const routes = process.argv.slice(2).length ? process.argv.slice(2) : allRoutes();
  if (!existsSync(join(ROOT, "dist/index.html"))) {
    console.error("No build to test. Run `npm run build` first.");
    process.exit(2);
  }

  const { chromium } = await import("playwright");
  const host = await startHost();
  // Playwright's bundled build may not match the browsers this machine ships.
  const executablePath = existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined;
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext();
  if (PROJECT_REF) {
    await context.addInitScript(([key, value]) => {
      try { localStorage.setItem(key, value); } catch { /* private mode */ }
    }, [`sb-${PROJECT_REF}-auth-token`, JSON.stringify(fakeSession())]);
  }

  let failed = 0;
  let offlineOnly = 0;
  for (const route of routes) {
    const page = await context.newPage();
    const appErrors = [];
    let networkErrors = 0;
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      if (NETWORK_NOISE.test(m.text())) networkErrors++;
      else appErrors.push(`console: ${m.text().slice(0, 300)}`);
    });
    page.on("pageerror", (e) => appErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

    let status = "—";
    try {
      const response = await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 30000 });
      status = response ? response.status() : "no-response";
    } catch (e) {
      appErrors.push(`navigation: ${String(e).slice(0, 200)}`);
    }
    await page.waitForTimeout(2000);
    const rendered = await page.evaluate(() => ({
      children: document.getElementById("root")?.children.length ?? -1,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim(),
    }));
    await page.close();

    const blank = rendered.children <= 0 || rendered.text.length < 20;
    const ok = !blank && appErrors.length === 0;
    if (!ok) failed++;
    else if (networkErrors) offlineOnly++;
    const tail = networkErrors ? ` (${networkErrors} backend call${networkErrors === 1 ? "" : "s"} unreachable)` : "";
    console.log(`${ok ? "ok  " : "FAIL"} ${route} [${status}] ${rendered.text.length} chars${tail}`);
    for (const e of appErrors) console.log(`       ${e}`);
  }

  await browser.close();
  host?.kill();
  console.log(`\n${routes.length - failed}/${routes.length} routes rendered clean` +
    (offlineOnly ? ` (${offlineOnly} of them with the backend unreachable)` : ""));
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
