import { describe, it, expect } from "vitest";
import { judgePersona, judgeStorage, runResilienceSuite } from "@/lib/offlineResilience";

const DAY = 86_400_000;

describe("offline resilience suite", () => {
  it("fails the persona check when nothing is saved on the device", () => {
    expect(judgePersona(null, 0).status).toBe("fail");
  });
  it("warns when the saved persona has under three days left of its 14", () => {
    expect(judgePersona({ fetchedAt: 0 }, 12 * DAY).status).toBe("warn");
    expect(judgePersona({ fetchedAt: 0 }, 1 * DAY).status).toBe("pass");
  });
  it("fails storage above the 750 MB device budget", () => {
    expect(judgeStorage(751 * 1024 * 1024, true).status).toBe("fail");
    expect(judgeStorage(700 * 1024 * 1024, true).status).toBe("pass");
  });
  it("reports LM Studio as failed, not passed, when it does not answer", async () => {
    const r = await runResilienceSuite({
      fetchImpl: async () => { throw new Error("down"); },
      userId: async () => "u", persona: async () => null,
      estimate: async () => ({ usage: 0 }), persisted: async () => true, serviceWorker: async () => true,
    });
    expect(r.find((c) => c.id === "lmstudio")?.status).toBe("fail");
  });
});
