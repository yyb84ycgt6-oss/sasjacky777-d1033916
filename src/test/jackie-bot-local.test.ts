import { describe, expect, it } from "vitest";
import { askJackieBotLocal } from "@/lib/jackieBotLocal";

const persona = async () => ({ ok: true as const, prompt: "You are Jackie." });

function fakeLmStudio(reply: string, seen: { body?: any; urls: string[] }) {
  return async (url: string, init?: RequestInit) => {
    seen.urls.push(url);
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "bonsai-1.7b" }] }));
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  };
}

describe("Jackie's bot on local LM Studio", () => {
  it("sends Jackie's persona as the system prompt directly to 127.0.0.1:1234", async () => {
    const seen = { urls: [] as string[] } as { body?: any; urls: string[] };
    const r = await askJackieBotLocal("hi", {}, { persona, fetchImpl: fakeLmStudio("Hello.", seen) });
    expect(r).toMatchObject({ ok: true, reply: "Hello.", model: "bonsai-1.7b" });
    expect(seen.urls.every((u) => u.startsWith("http://127.0.0.1:1234/"))).toBe(true);
    expect(seen.body.messages[0]).toEqual({ role: "system", content: "You are Jackie." });
  });

  it("treats an empty answer as a failure, not a blank reply", async () => {
    const r = await askJackieBotLocal("hi", {}, { persona, fetchImpl: fakeLmStudio("  ", { urls: [] }) });
    expect(r.ok).toBe(false);
  });

  it("refuses to answer without her persona", async () => {
    const r = await askJackieBotLocal("hi", {}, {
      persona: async () => ({ ok: false as const, issue: { title: "Owner only", recovery: "Sign in." } }),
      fetchImpl: fakeLmStudio("x", { urls: [] }),
    });
    expect(r).toEqual({ ok: false, error: "Owner only. Sign in." });
  });
});
