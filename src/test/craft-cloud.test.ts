import { beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for the Supabase client: a signed-in (or not) session, and a
// craft_worlds table that is one in-memory map of rows.
const state = vi.hoisted(() => ({
  user: "user-1" as string | null,
  rows: new Map<string, Record<string, unknown>>(),
  fail: null as { message: string; code?: string } | null,
}));

vi.mock("@/integrations/supabase/client", () => {
  const result = <T>(data: T) => Promise.resolve(state.fail ? { data: null, error: state.fail } : { data, error: null });
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: state.user ? { user: { id: state.user } } : null } }) },
      from: () => ({
        select: () => ({
          order: () => result([...state.rows.values()]),
          eq: (_c: string, id: string) => ({ maybeSingle: () => result(state.rows.get(id) ?? null) }),
        }),
        upsert: (row: Record<string, unknown>) => {
          if (!state.fail) state.rows.set(row.id as string, { ...row, updated_at: new Date().toISOString() });
          return result(null);
        },
        delete: () => ({ eq: (_c: string, id: string) => { if (!state.fail) state.rows.delete(id); return result(null); } }),
      }),
    },
  };
});

import { deleteCloudWorld, downloadWorld, explainCloudError, listCloudWorlds, uploadWorld } from "@/craft/game/cloud";
import { newWorldMeta, SaveStore } from "@/craft/game/save";
import { CHUNK_VOLUME } from "@/craft/engine/constants";

function world(name = "Home") {
  return newWorldMeta({ name, seed: 42, seedText: "42", type: "default", gameMode: "survival", difficulty: 2, hardcore: false, cheats: false });
}

describe("cloud worlds", () => {
  beforeEach(() => {
    state.user = "user-1";
    state.rows.clear();
    state.fail = null;
  });

  it("round-trips a world through the cloud onto a device that has never seen it", async () => {
    const here = new SaveStore();
    const meta = world();
    await here.putWorld(meta);
    const blocks = new Uint8Array(CHUNK_VOLUME).fill(1);
    await here.putChunks(meta.id, [{ cx: 3, cz: -2, blocks, meta: new Uint8Array(CHUNK_VOLUME), entities: [] }]);

    const up = await uploadWorld(here, meta);
    expect(up.error).toBeUndefined();

    const there = new SaveStore();
    const listed = await listCloudWorlds();
    expect(listed.value?.map((w) => w.name)).toEqual(["Home"]);

    const down = await downloadWorld(there, meta.id);
    expect(down.error).toBeUndefined();
    expect(down.value?.id).toBe(meta.id);
    const chunk = await there.getChunk(meta.id, 3, -2);
    expect(chunk?.blocks[100]).toBe(1);
  });

  it("replaces this device's copy of the same world instead of adding a second", async () => {
    const saves = new SaveStore();
    const meta = world();
    await saves.putWorld(meta);
    await uploadWorld(saves, meta);
    await downloadWorld(saves, meta.id);
    const worlds = await saves.listWorlds();
    expect(worlds.map((w) => w.name)).toEqual(["Home"]);
    expect(worlds[0].id).toBe(meta.id);
  });

  it("answers a signed-out player with a sentence, not an exception", async () => {
    state.user = null;
    const v = await listCloudWorlds();
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/Sign in/);
  });

  it("says the server has no cloud saves yet when the table was never deployed", async () => {
    state.fail = { message: 'relation "public.craft_worlds" does not exist', code: "42P01" };
    const v = await listCloudWorlds();
    expect(v.error).toMatch(/supabase db push/);
    expect(v.error).toMatch(/unaffected/);
  });

  it("keeps the local world when the upload is refused", async () => {
    const saves = new SaveStore();
    const meta = world();
    await saves.putWorld(meta);
    state.fail = { message: "Failed to fetch" };
    const v = await uploadWorld(saves, meta);
    expect(v.error).toMatch(/Could not reach the cloud/);
    expect((await saves.listWorlds()).map((w) => w.id)).toEqual([meta.id]);
  });

  it("removes only the cloud copy", async () => {
    const saves = new SaveStore();
    const meta = world();
    await saves.putWorld(meta);
    await uploadWorld(saves, meta);
    expect((await deleteCloudWorld(meta.id)).ok).toBe(true);
    expect((await listCloudWorlds()).value).toEqual([]);
    expect((await saves.listWorlds()).length).toBe(1);
  });

  it("names a network failure as the network, and an unknown one in the server's words", () => {
    expect(explainCloudError("TypeError: Failed to fetch")).toMatch(/connection/);
    expect(explainCloudError("something odd")).toBe("The cloud refused: something odd");
  });
});
