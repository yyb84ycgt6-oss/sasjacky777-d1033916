import { describe, expect, it } from "vitest";
import { verifyOfflineReply } from "@/lib/offlineReplyCheck";
import type { CachedPersona } from "@/lib/microai/personaCache";

const savedPersona: CachedPersona = { userId: "u", prompt: "You are Jackie.", mode: "default", fetchedAt: 0 };

/** Answers like LM Studio: lists one model, then replies (or refuses) on the completion call. */
function fakeLmStudio(completions: () => Response) {
  return async (url: string) => {
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "bonsai-1.7b" }] }));
    return completions();
  };
}

const deps = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) => ({
  userId: async () => "u",
  persona: async () => savedPersona,
  fetchImpl,
});

describe("offline reply check", () => {
  it("reports the server's own words when the local model refuses", async () => {
    const r = await verifyOfflineReply(deps(fakeLmStudio(() => new Response("", { status: 500 }))));
    expect(r.status).toBe("fail");
    expect(r.detail).toBe("LM Studio refused the request (HTTP 500).");
  });

  it("passes on a generated reply and names the model without quoting the answer", async () => {
    const r = await verifyOfflineReply(deps(fakeLmStudio(() => new Response(JSON.stringify({
      model: "bonsai-1.7b",
      choices: [{ message: { content: "Received and understood." } }],
    })))));
    expect(r.status).toBe("pass");
    expect(r.detail).toContain("bonsai-1.7b");
    expect(r.detail).not.toContain("Received and understood.");
  });

  it("fails without a saved persona rather than answering as an anonymous model", async () => {
    const r = await verifyOfflineReply({ userId: async () => "u", persona: async () => null });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("No usable saved persona");
  });
});
