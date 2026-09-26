/**
 * Map packs: whole worlds built for a game mode rather than grown from noise
 * — the islands of SkyBlock, the lone block of OneBlock, a parkour course in
 * the sky, a colosseum for waves of monsters, the layered floors of TNT Run,
 * the arena of the Survival Games (real terrain with a cornucopia at its
 * heart), and Primal's Island (a land ringed by sea, its three obelisks
 * standing over it). Each is laid out from the seed alone, so every worker and every
 * friend in the world builds the same one, and stamped chunk by chunk as the
 * world generates, like the other structures.
 *
 * A map that keeps natural terrain wraps the ordinary generator and lays its
 * pieces over it; the rest are void with their pieces floating in it.
 */
import { B, WOOL_COLORS } from "./blocks";
import { BiomeId, biomeDef, foliageColor, grassColor, waterColor } from "./biomes";
import { blockIndex, CHUNK_VOLUME, WORLD_HEIGHT } from "./constants";
import { itemByName, type ItemStack } from "./items";
import { hash4, Rng } from "./rng";
import type { ChunkGenerator, GeneratedChunk, Generator, Tints } from "./worldgen";

export const MAP_IDS = ["skyblock", "oneblock", "void", "parkour", "colosseum", "tnt_run", "sg_arena", "primal_island"] as const;
export type MapId = (typeof MAP_IDS)[number];
export const isMapId = (v: unknown): v is MapId => typeof v === "string" && (MAP_IDS as readonly string[]).includes(v);

export interface MapInfo {
  name: string;
  description: string;
}

export const MAPS: Record<MapId, MapInfo> = {
  skyblock: { name: "SkyBlock", description: "A little L of dirt, a tree and a chest, hanging over the void. A sand island waits across the gap." },
  oneblock: { name: "OneBlock", description: "One block in the void. Break it, and it comes back as something else." },
  void: { name: "The Void", description: "A single platform in an empty world: a blank page for building." },
  parkour: { name: "Parkour Paradise", description: "A course of jumps in the sky, four stages hard, with gold checkpoints and a diamond finish." },
  colosseum: { name: "The Colosseum", description: "A sand-floored arena ringed in stone, with four gates the waves come through." },
  tnt_run: { name: "TNT Run Floors", description: "Three floors of wool over the void. Every block you step on falls away." },
  sg_arena: { name: "Survival Games Arena", description: "Real terrain around a cornucopia of chests, twelve spawn pads, and loot hidden in the wild." },
  primal_island: { name: "The Island", description: "An island some fourteen hundred blocks across, ringed by open sea, with three great obelisks. You wake on its southern beach." },
};

/** Loot tables a map's chests are filled from (see mapLoot). */
export type MapLoot = "skyblock_start" | "skyblock_sand" | "sg_center" | "sg_wild" | "arena_gear";

export interface MapLayout {
  map: MapId;
  spawn: [number, number, number];
  /** Blocks by chunk ("cx,cz"), flat as x, y, z, id, meta. */
  blocks: Map<string, number[]>;
  chests: [number, number, number, MapLoot][];
  /** Keeps the ordinary terrain under the map's pieces. */
  terrain: boolean;
  /** OneBlock: the block that comes back. */
  oneBlock?: [number, number, number];
  /** Parkour: the checkpoint pads in order (the start first); the finish pad last. */
  checkpoints?: [number, number, number][];
  /** Survival Games: the pads the players and tributes start on. Colosseum: the gates the waves come through. */
  pads?: [number, number, number][];
  /** Where a mode's border centres, and how wide the play area is. */
  center: [number, number];
  radius: number;
  /** Falling below this is out (void maps). */
  floorY: number;
  /** TNT Run: the floors' heights, top first. */
  floors?: number[];
}

class Plan {
  readonly blocks = new Map<string, number[]>();
  set(x: number, y: number, z: number, id: number, meta = 0): void {
    if (y < 1 || y >= WORLD_HEIGHT - 1) return;
    const k = `${x >> 4},${z >> 4}`;
    let list = this.blocks.get(k);
    if (!list) { list = []; this.blocks.set(k, list); }
    list.push(x, y, z, id, meta);
  }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, meta = 0): void {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, id, meta);
  }
}

const wool = (color: (typeof WOOL_COLORS)[number]) => B.WHITE_WOOL + WOOL_COLORS.indexOf(color);

/** An oak: a five-log trunk and a round crown, as the islands start with. */
function oak(p: Plan, x: number, y: number, z: number): void {
  for (let dy = 0; dy < 5; dy++) p.set(x, y + dy, z, B.OAK_LOG);
  for (let dy = 3; dy <= 6; dy++) {
    const r = dy >= 5 ? 1 : 2;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      if ((dx || dz || dy > 4) && !(Math.abs(dx) === 2 && Math.abs(dz) === 2)) p.set(x + dx, y + dy, z + dz, B.OAK_LEAVES);
    }
  }
}

function skyblock(): Omit<MapLayout, "map"> {
  const p = new Plan();
  // The classic L: three layers, grass on top, a block of bedrock under where you stand.
  for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) {
    if (x >= 3 && z >= 3) continue;
    p.set(x, 60, z, x === 1 && z === 1 ? B.BEDROCK : B.DIRT);
    p.set(x, 61, z, B.DIRT);
    p.set(x, 62, z, B.GRASS);
  }
  oak(p, 4, 63, 1);
  p.set(0, 63, 5, B.CHEST, 1);
  // The sand island, far enough to need a bridge.
  for (let x = 60; x <= 62; x++) for (let z = 0; z <= 2; z++) { p.set(x, 60, z, B.SANDSTONE); p.set(x, 61, z, B.SAND); p.set(x, 62, z, B.SAND); }
  p.set(62, 63, 2, B.CACTUS);
  p.set(60, 63, 0, B.CHEST, 1);
  return {
    spawn: [1.5, 63, 1.5], blocks: p.blocks, terrain: false, center: [2, 2], radius: 400, floorY: 0,
    chests: [[0, 63, 5, "skyblock_start"], [60, 63, 0, "skyblock_sand"]],
  };
}

function oneblock(): Omit<MapLayout, "map"> {
  const p = new Plan();
  p.set(0, 64, 0, B.GRASS);
  return { spawn: [0.5, 65, 0.5], blocks: p.blocks, terrain: false, chests: [], oneBlock: [0, 64, 0], center: [0, 0], radius: 400, floorY: 0 };
}

function voidMap(): Omit<MapLayout, "map"> {
  const p = new Plan();
  p.box(-2, 64, -2, 2, 64, 2, B.SMOOTH_STONE);
  return { spawn: [0.5, 65, 0.5], blocks: p.blocks, terrain: false, chests: [], center: [0, 0], radius: 2000, floorY: 0 };
}

/** One jump of the parkour course: the gap to clear, the step up or down, and what the landing is made of. */
export interface Jump { gap: number; dy: number; block: number }

/**
 * The course's jumps, stage by stage. Every jump is one this game's physics
 * can make (craft-modes.test.ts sprint-jumps each kind): a gap of up to three
 * on the level, two when stepping up a block, four when dropping one.
 */
export function parkourJumps(seed: number): Jump[] {
  const rng = new Rng(hash4(seed, 0x9a4c));
  const out: Jump[] = [];
  const stages: [number, () => Jump][] = [
    [12, () => ({ gap: 1 + rng.int(2), dy: rng.next() < 0.4 ? 1 : 0, block: B.OAK_PLANKS })],
    [12, () => { const dy = [-1, 0, 1][rng.int(3)]; return { gap: dy > 0 ? 2 : 2 + rng.int(2), dy, block: B.STONE_BRICKS }; }],
    [12, () => { const dy = rng.next() < 0.5 ? -1 : 0; return { gap: dy < 0 ? 3 + rng.int(2) : 2 + rng.int(2), dy, block: rng.next() < 0.3 ? B.PACKED_ICE : B.QUARTZ_BLOCK }; }],
    [12, () => { const dy = rng.next() < 0.35 ? 1 : 0; return { gap: dy > 0 ? 2 : 3, dy, block: B.OBSIDIAN }; }],
  ];
  for (const [n, make] of stages) {
    for (let i = 0; i < n; i++) {
      const j = make();
      // A climbing jump from ice would slide off: keep ice for the level and the drops.
      if (j.block === B.PACKED_ICE && j.dy > 0) j.dy = 0;
      out.push(j);
    }
  }
  return out;
}

function parkour(seed: number): Omit<MapLayout, "map"> {
  const p = new Plan();
  const rng = new Rng(hash4(seed, 0x51de));
  let x = 0, y = 100, z = 0;
  // The start: a pad of gold, with a railing of glass so a new runner does not step off backwards.
  p.box(-2, y, -2, 2, y, 2, B.GOLD_BLOCK);
  for (let i = -2; i <= 2; i++) p.set(i, y + 1, -3, B.GLASS);
  const checkpoints: [number, number, number][] = [[0, y + 1, 0]];
  const jumps = parkourJumps(seed);
  let minY = y;
  jumps.forEach((j, i) => {
    // Mostly forward, drifting a little to the side, never back on itself.
    // A sideways step lengthens the jump, so only the shorter jumps take one.
    const side = j.gap <= 2 && j.dy <= 0 && rng.next() < 0.35 ? (rng.next() < 0.5 ? -1 : 1) : 0;
    z += j.gap + 1;
    x += side;
    y += j.dy;
    minY = Math.min(minY, y);
    const pad = (i + 1) % 12 === 0;
    if (pad) {
      p.box(x - 1, y, z - 1, x + 1, y, z + 1, i === jumps.length - 1 ? B.DIAMOND_BLOCK : B.GOLD_BLOCK);
      p.set(x, y + 1, z + 1, B.LANTERN);
      checkpoints.push([x, y + 1, z]);
      z += 1;
    } else p.set(x, y, z, j.block);
  });
  return {
    spawn: [0.5, 101, 0.5], blocks: p.blocks, terrain: false, chests: [], checkpoints,
    center: [0, Math.round(z / 2)], radius: z, floorY: minY - 12,
  };
}

function colosseum(): Omit<MapLayout, "map"> {
  const p = new Plan();
  const R = 22, Y = 64;
  const gates: [number, number, number][] = [];
  for (let x = -R - 8; x <= R + 8; x++) for (let z = -R - 8; z <= R + 8; z++) {
    const d = Math.hypot(x, z);
    if (d > R + 8) continue;
    for (let y = Y - 6; y < Y; y++) p.set(x, y, z, y === Y - 6 ? B.BEDROCK : B.STONE);
    if (d <= R) p.set(x, Y, z, (x + z) % 7 === 0 ? B.SANDSTONE : B.SAND);
    else if (d <= R + 2) {
      // The wall, with a gate at each point of the compass.
      const gate = (Math.abs(x) <= 1 && Math.abs(z) > R - 1) || (Math.abs(z) <= 1 && Math.abs(x) > R - 1);
      p.set(x, Y, z, B.STONE_BRICKS);
      for (let y = Y + 1; y <= Y + 7; y++) p.set(x, y, z, gate && y <= Y + 3 ? B.AIR : y === Y + 7 ? B.CHISELED_STONE_BRICKS : (x * 3 + y + z) % 11 === 0 ? B.MOSSY_STONE_BRICKS : B.STONE_BRICKS);
      if (gate) p.set(x, Y + 4, z, B.IRON_BARS);
    } else {
      // Terraced seats for a crowd that never comes.
      const tier = Math.floor(d - R - 2);
      p.set(x, Y, z, B.STONE_BRICKS);
      for (let y = Y + 1; y <= Y + 7 + tier; y++) p.set(x, y, z, y === Y + 7 + tier ? B.STONE_BRICK_SLAB : B.STONE_BRICKS);
    }
  }
  for (const [gx, gz] of [[0, -(R + 5)], [R + 5, 0], [0, R + 5], [-(R + 5), 0]]) {
    // A tunnel behind each gate, where the monsters wait.
    const ax = Math.sign(gx), az = Math.sign(gz);
    for (let s = R + 1; s <= R + 7; s++) for (let w = -1; w <= 1; w++) for (let y = Y + 1; y <= Y + 3; y++) {
      p.set(ax * s + (az !== 0 ? w : 0), y, az * s + (ax !== 0 ? w : 0), B.AIR);
    }
    gates.push([ax * (R + 5), Y + 1, az * (R + 5)]);
  }
  for (const [lx, lz] of [[R - 1, R - 8], [-(R - 1), -(R - 8)], [R - 8, -(R - 1)], [-(R - 8), R - 1]]) p.set(lx, Y + 1, lz, B.LANTERN);
  p.set(2, Y + 1, 2, B.CHEST, 0);
  return {
    spawn: [0.5, Y + 1, 0.5], blocks: p.blocks, terrain: false, chests: [[2, Y + 1, 2, "arena_gear"]], pads: gates,
    center: [0, 0], radius: R, floorY: Y - 10,
  };
}

function tntRun(): Omit<MapLayout, "map"> {
  const p = new Plan();
  const floors = [90, 84, 78];
  const colors = [wool("yellow"), wool("orange"), wool("red")];
  floors.forEach((y, i) => {
    for (let x = -15; x <= 15; x++) for (let z = -15; z <= 15; z++) p.set(x, y, z, (x + z) % 2 === 0 ? colors[i] : wool(i === 0 ? "lime" : i === 1 ? "magenta" : "purple"));
  });
  return { spawn: [0.5, 91, 0.5], blocks: p.blocks, terrain: false, chests: [], floors, center: [0, 0], radius: 15, floorY: 70 };
}

/**
 * Primal's Island. The generator shapes the land itself (worldgen.ts sinks
 * everything past a radius into the sea); the map adds the three obelisks —
 * red, green and blue, as on the Island — and wakes you on the southern beach.
 */
function primalIsland(base: Generator): Omit<MapLayout, "map"> {
  const p = new Plan();
  const obelisks: [number, number, number][] = [[0, -280, wool("red")], [-242, 140, wool("green")], [242, 140, wool("blue")]];
  for (const [ox, oz, color] of obelisks) {
    const y = Math.max(64, base.surfaceY(ox, oz));
    // A stepped plinth of obsidian, a column of its colour, and a lantern crown seen from far off.
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const edge = Math.max(Math.abs(dx), Math.abs(dz));
      for (let yy = y - 4; yy <= y + (edge <= 2 ? 2 : 1); yy++) p.set(ox + dx, yy, oz + dz, B.OBSIDIAN);
    }
    for (let yy = y + 3; yy <= y + 34; yy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      p.set(ox + dx, yy, oz + dz, (yy - y) % 8 === 0 ? B.SEA_LANTERN : color);
    }
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) p.set(ox + dx, y + 35, oz + dz, B.GLOWSTONE);
  }
  // The south beach: coming in from the open sea, the first dry ground (a river inland is not the coast).
  let sz = 300;
  for (let z = 780; z > 300; z -= 2) {
    if (base.surfaceY(0, z) >= 63) { sz = z - 3; break; }
  }
  const sy = Math.max(63, base.surfaceY(0, sz)) + 1;
  return { spawn: [0.5, sy, sz + 0.5], blocks: p.blocks, terrain: true, chests: [], center: [0, 0], radius: 700, floorY: -64 };
}

function sgArena(seed: number, base: Generator): Omit<MapLayout, "map"> {
  const p = new Plan();
  const s = base.findSpawn();
  const cx = Math.floor(s.x), cz = Math.floor(s.z), y = base.surfaceY(cx, cz);
  // The cornucopia's floor: a round platform of smooth stone, cleared above.
  for (let x = -14; x <= 14; x++) for (let z = -14; z <= 14; z++) {
    if (Math.hypot(x, z) > 14.5) continue;
    for (let yy = y - 3; yy <= y; yy++) p.set(cx + x, yy, cz + z, yy === y ? B.SMOOTH_STONE : B.STONE);
    for (let yy = y + 1; yy <= y + 6; yy++) p.set(cx + x, yy, cz + z, B.AIR);
  }
  // The horn itself: a golden arch over the centre chests.
  for (let i = -2; i <= 2; i++) { p.set(cx + i, y + 4, cz - 2, B.GOLD_BLOCK); p.set(cx + i, y + 4, cz + 2, B.GOLD_BLOCK); }
  for (let yy = y + 1; yy <= y + 3; yy++) for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) p.set(cx + dx, yy, cz + dz, B.GOLD_BLOCK);
  const chests: MapLayout["chests"] = [];
  for (const [dx, dz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) { p.set(cx + dx, y + 1, cz + dz, B.CHEST); chests.push([cx + dx, y + 1, cz + dz, "sg_center"]); }
  const pads: [number, number, number][] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const px = cx + Math.round(Math.cos(a) * 11), pz = cz + Math.round(Math.sin(a) * 11);
    p.set(px, y, pz, B.IRON_BLOCK);
    pads.push([px, y + 1, pz]);
  }
  // Chests hidden in the wild, on the ground within the arena.
  const rng = new Rng(hash4(seed, 0x5a11));
  for (let i = 0; i < 28; i++) {
    const a = rng.next() * Math.PI * 2, r = 30 + rng.next() * 110;
    const x = cx + Math.round(Math.cos(a) * r), z = cz + Math.round(Math.sin(a) * r);
    const gy = base.surfaceY(x, z);
    if (gy < 63) continue;
    p.set(x, gy + 1, z, B.CHEST, rng.int(4));
    chests.push([x, gy + 1, z, "sg_wild"]);
  }
  return { spawn: [cx + 0.5, y + 1, cz + 0.5], blocks: p.blocks, terrain: true, chests, pads, center: [cx, cz], radius: 150, floorY: 0 };
}

const layouts = new Map<string, MapLayout>();

/** A map's layout for a seed, the same every time. Terrain maps need the ordinary generator to stand on. */
export function mapLayout(map: MapId, seed: number, base: Generator): MapLayout {
  const key = `${map}:${seed}`;
  let l = layouts.get(key);
  if (!l) {
    const made = map === "skyblock" ? skyblock() : map === "oneblock" ? oneblock() : map === "void" ? voidMap()
      : map === "parkour" ? parkour(seed) : map === "colosseum" ? colosseum() : map === "tnt_run" ? tntRun()
        : map === "primal_island" ? primalIsland(base) : sgArena(seed, base);
    l = { map, ...made };
    if (layouts.size > 16) layouts.clear();
    layouts.set(key, l);
  }
  return l;
}

/**
 * The generator for a world played on a map pack: the map's pieces, over
 * void or over the ordinary terrain.
 */
export class MapGenerator implements ChunkGenerator {
  readonly layout: MapLayout;
  private plainsTints: Tints | null = null;

  constructor(readonly map: MapId, readonly base: Generator) {
    this.layout = mapLayout(map, base.seed, base);
  }

  get seed(): number {
    return this.base.seed;
  }

  /** The ordinary generator, where the map keeps its terrain (and so its villages and strongholds). */
  get terrain(): Generator | null {
    return this.layout.terrain ? this.base : null;
  }

  generate(cx: number, cz: number): GeneratedChunk {
    let out: GeneratedChunk;
    if (this.layout.terrain) out = this.base.generate(cx, cz);
    else out = { blocks: new Uint8Array(CHUNK_VOLUME), meta: new Uint8Array(CHUNK_VOLUME), biomes: new Uint8Array(256).fill(BiomeId.Plains) };
    const list = this.layout.blocks.get(`${cx},${cz}`) ?? [];
    for (let i = 0; i < list.length; i += 5) {
      const idx = blockIndex(list[i] - cx * 16, list[i + 1], list[i + 2] - cz * 16);
      out.blocks[idx] = list[i + 3];
      out.meta[idx] = list[i + 4];
    }
    return out;
  }

  biomeAt(x: number, z: number): number {
    return this.layout.terrain ? this.base.biomeAt(x, z) : BiomeId.Plains;
  }

  tints(cx: number, cz: number): Tints {
    if (this.layout.terrain) return this.base.tints(cx, cz);
    if (!this.plainsTints) {
      const b = biomeDef(BiomeId.Plains);
      const g = grassColor(b, 0.8, 0.4), f = foliageColor(b, 0.8, 0.4), w = waterColor(b);
      const t = new Uint8Array(256 * 9);
      for (let i = 0; i < 256; i++) t.set([...g, ...f, ...w], i * 9);
      this.plainsTints = t;
    }
    // A copy each time: the worker transfers what it returns, and a transferred buffer is gone —
    // handing out the same one twice stalled every void map after its first chunk per worker.
    return this.plainsTints.slice();
  }

  findSpawn(): { x: number; y: number; z: number } {
    const [x, y, z] = this.layout.spawn;
    return { x, y, z };
  }

  /** The map's chests in a chunk, for the game to fill as it appears. */
  chestsIn(cx: number, cz: number): [number, number, number, MapLoot][] {
    return this.layout.chests.filter(([x, , z]) => x >> 4 === cx && z >> 4 === cz);
  }
}

const TABLES: Record<MapLoot, LootTable> = {
  // The original's starting chest, near enough: lava and ice for cobblestone, seeds of every kind.
  skyblock_start: [["lava_bucket", 1, 1, 1], ["ice", 2, 2, 1], ["melon_slice", 1, 1, 1], ["sugar_cane", 1, 1, 1], ["red_mushroom", 1, 1, 1],
    ["brown_mushroom", 1, 1, 1], ["wheat_seeds", 2, 2, 1], ["bone_meal", 3, 3, 1], ["carrot", 1, 1, 1], ["potato", 1, 1, 1], ["pumpkin", 1, 1, 1]],
  skyblock_sand: [["obsidian", 10, 10, 1], ["ice", 1, 1, 1], ["cactus", 1, 1, 1], ["sand", 4, 4, 1]],
  sg_center: [["iron_sword", 1, 1, 0.45], ["stone_sword", 1, 1, 0.5], ["bow", 1, 1, 0.35], ["arrow", 4, 10, 0.5], ["iron_chestplate", 1, 1, 0.3],
    ["iron_helmet", 1, 1, 0.3], ["iron_leggings", 1, 1, 0.25], ["iron_boots", 1, 1, 0.3], ["golden_apple", 1, 1, 0.2], ["cooked_beef", 2, 5, 0.6],
    ["bread", 2, 4, 0.5], ["diamond", 1, 1, 0.1], ["iron_axe", 1, 1, 0.3]],
  sg_wild: [["wooden_sword", 1, 1, 0.35], ["stone_sword", 1, 1, 0.3], ["stone_axe", 1, 1, 0.3], ["leather_helmet", 1, 1, 0.3],
    ["leather_chestplate", 1, 1, 0.3], ["leather_boots", 1, 1, 0.3], ["golden_helmet", 1, 1, 0.15], ["apple", 1, 3, 0.5], ["bread", 1, 2, 0.4],
    ["arrow", 2, 6, 0.3], ["flint", 1, 3, 0.2], ["iron_ingot", 1, 2, 0.2], ["stick", 1, 3, 0.4], ["flint_and_steel", 1, 1, 0.1]],
  arena_gear: [["iron_sword", 1, 1, 1], ["bow", 1, 1, 1], ["arrow", 32, 32, 1], ["iron_chestplate", 1, 1, 1], ["iron_helmet", 1, 1, 1],
    ["cooked_beef", 16, 16, 1], ["golden_apple", 2, 2, 1]],
};

/** A loot table: item name, fewest, most, and the chance of it appearing at all. */
export type LootTable = readonly (readonly [string, number, number, number])[];

/**
 * Fills a chest from a table. Starting chests (`ordered`) fill slot by slot,
 * like a kit; loot is scattered, like loot. Names the game lacks are skipped
 * rather than failing the chest.
 */
export function fillLoot(items: (ItemStack | null)[], rng: Rng, table: LootTable, ordered: boolean): void {
  let slot = 0;
  for (const [name, lo, hi, chance] of table) {
    if (rng.next() >= chance) continue;
    let id: number;
    try { id = itemByName(name).id; } catch { continue; }
    const at = ordered ? slot++ : rng.int(items.length);
    if (at < items.length && !items[at]) items[at] = { id, count: lo + rng.int(hi - lo + 1) };
  }
}

/** Fills a map chest from its table. */
export function mapLoot(items: (ItemStack | null)[], seed: number, table: MapLoot): void {
  fillLoot(items, new Rng(seed), TABLES[table], table.startsWith("skyblock") || table === "arena_gear");
}

/** Every item name the map tables use, for the test that keeps them real. */
export function mapLootNames(): string[] {
  return Object.values(TABLES).flatMap((t) => t.map(([n]) => n));
}
