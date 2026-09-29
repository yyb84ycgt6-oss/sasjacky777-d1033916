import { describe, expect, it, vi, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  VAULTS, MIN_FALLBACKS, SLOTS_PER_VAULT, keySlots, vaultChain,
} from "@/lib/providerVaults";
import { findProvider, PROVIDERS } from "@/lib/jackie-providers";
import { streamProviderChat } from "@/lib/jackie-provider-stream";
import * as edge from "@/lib/edgeFunction";

describe("provider vaults", () => {
  it("ships five vaults of five key slots — twenty-five in all", () => {
    expect(VAULTS).toHaveLength(5);
    for (const v of VAULTS) expect(v.slots).toHaveLength(SLOTS_PER_VAULT);
    expect(VAULTS.flatMap((v) => keySlots(v))).toHaveLength(25);
  });

  it("never puts the same provider in one vault twice, which would waste a slot", () => {
    for (const v of VAULTS) {
      const ids = v.slots.map((s) => s.provider);
      expect(new Set(ids).size, v.id).toBe(ids.length);
    }
  });

  it("gives every slot a secret to paste into and a page to get it from", () => {
    for (const v of VAULTS) {
      for (const k of keySlots(v)) {
        expect(k.secret, `${v.id}/${k.provider}`).toMatch(/^[A-Z][A-Z0-9_]+$/);
        expect(k.url, `${v.id}/${k.provider}`).toMatch(/^https:\/\//);
      }
    }
  });

  it("only asks a provider for a model it actually offers, so a fallback is never refused by the allowlist", () => {
    for (const v of VAULTS) {
      for (const s of v.slots) {
        if (!s.model) continue;
        const models = findProvider(s.provider)!.models.map((m) => m.id);
        expect(models, `${v.id}/${s.provider}`).toContain(s.model);
      }
    }
  });

  it("points every slot at an edge function that exists in the repo", () => {
    for (const v of VAULTS) {
      for (const s of v.slots) {
        const fn = findProvider(s.provider)!.fn;
        expect(existsSync(resolve(__dirname, "../../supabase/functions", fn, "index.ts")), fn).toBe(true);
      }
    }
  });

  it(`keeps at least ${MIN_FALLBACKS} backups behind every vault's first choice`, () => {
    for (const v of VAULTS) {
      const chain = vaultChain(v);
      expect(chain.length - 1, v.id).toBeGreaterThanOrEqual(MIN_FALLBACKS);
      expect(chain.map((l) => l.provider).slice(0, 5)).toEqual(v.slots.map((s) => s.provider));
    }
  });

  it("falls through to every provider in the hub, so a vault with no keys still reaches the keyless gateway", () => {
    for (const v of VAULTS) {
      const ids = vaultChain(v).map((l) => l.provider);
      expect(new Set(ids).size).toBe(PROVIDERS.length);
      expect(ids).toContain("lovable");
    }
  });
});

describe("streaming through a vault's chain", () => {
  afterEach(() => vi.restoreAllMocks());

  it("falls back in the vault's order and on the vault's model, not the hub's defaults", async () => {
    const calls: { fn: string; model: string }[] = [];
    vi.spyOn(edge, "callEdgeFunction").mockImplementation(async (fn: string, body: unknown) => {
      calls.push({ fn, model: (body as { model: string }).model });
      if (fn === "jackie-mistral") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\ndata: [DONE]\n\n`,
            ));
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response(JSON.stringify({ error: "rate limited" }), { status: 429 });
    });

    const code = VAULTS.find((v) => v.id === "code")!;
    const done: string[] = [];
    await streamProviderChat({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "x" }],
      fallback: true,
      chain: vaultChain(code),
      onDelta: () => {},
      onDone: (m) => done.push(`${m?.servedBy}:${m?.model}`),
      onError: (e) => done.push(`error:${e}`),
    });

    expect(calls.map((c) => c.fn)).toEqual(["jackie-deepseek", "jackie-mistral"]);
    expect(done).toEqual(["mistral:codestral-latest"]);
  });
});
