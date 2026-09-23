/**
 * How blocks behave on their own: water and lava flowing, sand falling,
 * plants popping off when their ground is dug out, crops and saplings
 * growing, grass spreading, leaves decaying once their tree is felled.
 *
 * Runs only where the world simulates (single player, or the host online).
 * Every change it makes goes through world.setBlock like a player's edit, so
 * it is saved and sent to guests on the same path.
 */
import {
  B, block, CROP_MAX_AGE, FACE_DIRS, FACING_DIRS, isButton, isCrop, isDoor, isFluid, isLeaves, isLog, isRedstoneTorch, isSapling,
  isSlab, OPPOSITE_FACING,
} from "./blocks";
import { biomeDef } from "./biomes";
import { blockIndex, WORLD_HEIGHT } from "./constants";
import { itemByName, resolveDrops, type ItemStack } from "./items";
import { Rng } from "./rng";
import { buildTree, saplingTree, type Place } from "./trees";
import type { World } from "./world";

export interface RuleContext {
  dropItems(x: number, y: number, z: number, stacks: ItemStack[]): void;
  spawnFalling(x: number, y: number, z: number, id: number, meta: number): void;
  sound(name: string, x: number, y: number, z: number, volume?: number, pitch?: number): void;
  isRaining(): boolean;
  random(): number;
}

const WATER_DELAY = 5;
const LAVA_DELAY = 30;

export function tickDelay(id: number): number {
  if (id === B.WATER) return WATER_DELAY;
  if (id === B.LAVA) return LAVA_DELAY;
  return 1;
}

const SOIL = new Set<number>([B.GRASS, B.DIRT, B.PODZOL, B.COARSE_DIRT, B.MOSS, B.FARMLAND, B.MUD]);

/** Whether a block that needs support still has it. */
export function supported(world: World, x: number, y: number, z: number, id: number, meta: number): boolean {
  const below = world.getBlock(x, y - 1, z);
  if (below < 0) return true; // unloaded: assume fine rather than break things at the edge
  const belowDef = block(below);
  switch (id) {
    case B.REDSTONE_WIRE: case B.REPEATER: case B.COMPARATOR:
      // On anything with a full top: a solid block, a top slab, a hopper.
      return belowDef.opaque || below === B.HOPPER || (isSlab(below) && world.getMeta(x, y - 1, z) !== 0);
    case B.LEVER: case B.STONE_BUTTON: case B.OAK_BUTTON: {
      const [dx, dy, dz] = FACE_DIRS[meta & 7];
      const holder = world.getBlock(x + dx, y + dy, z + dz);
      return holder < 0 || block(holder).opaque;
    }
    case B.STONE_PLATE: case B.OAK_PLATE:
      return belowDef.opaque || below === B.OAK_FENCE || below === B.HOPPER || (isSlab(below) && world.getMeta(x, y - 1, z) !== 0);
    case B.RAIL: case B.POWERED_RAIL: case B.DETECTOR_RAIL: case B.ACTIVATOR_RAIL:
      // Track needs a full block under it (a top slab or a hopper will do, as in the original).
      return belowDef.opaque || below === B.HOPPER || (isSlab(below) && world.getMeta(x, y - 1, z) !== 0);
    case B.REDSTONE_TORCH: case B.REDSTONE_TORCH_OFF:
    case B.TORCH: {
      if (meta === 0) return belowDef.solid && (belowDef.opaque || below === B.OAK_FENCE || below === B.GLASS);
      const [dx, dz] = FACING_DIRS[(meta - 1) & 3];
      const wall = world.getBlock(x - dx, y, z - dz);
      return wall < 0 || block(wall).opaque;
    }
    case B.LADDER: {
      const [dx, dz] = FACING_DIRS[meta & 3];
      const wall = world.getBlock(x + dx, y, z + dz);
      return wall < 0 || block(wall).opaque;
    }
    case B.WHEAT: case B.CARROTS: case B.POTATOES:
      return below === B.FARMLAND;
    case B.DEAD_BUSH:
      return below === B.SAND || below === B.RED_SAND || below === B.TERRACOTTA || SOIL.has(below) || (below >= B.ORANGE_TERRACOTTA && below <= B.WHITE_TERRACOTTA);
    case B.BROWN_MUSHROOM: case B.RED_MUSHROOM:
      return belowDef.opaque;
    case B.SUGAR_CANE: {
      if (below === B.SUGAR_CANE) return true;
      if (!SOIL.has(below) && below !== B.SAND && below !== B.RED_SAND) return false;
      for (const [dx, dz] of FACING_DIRS) {
        const n = world.getBlock(x + dx, y - 1, z + dz);
        if (n === B.WATER || n === B.ICE || n < 0) return true;
      }
      return false;
    }
    case B.CACTUS: {
      if (below !== B.CACTUS && below !== B.SAND && below !== B.RED_SAND) return false;
      for (const [dx, dz] of FACING_DIRS) if (block(world.blockAt(x + dx, y, z + dz)).solid) return false;
      return true;
    }
    case B.LILY_PAD:
      return below === B.WATER || below === B.ICE;
    case B.SNOW: case B.LANTERN:
      return belowDef.solid && below !== B.ICE;
    case B.OAK_DOOR: case B.IRON_DOOR: {
      const upper = (meta & 8) !== 0;
      if (upper) return world.blockAt(x, y - 1, z) === id;
      return belowDef.opaque && world.blockAt(x, y + 1, z) === id;
    }
    case B.RED_BED: {
      const head = (meta & 4) !== 0;
      const [dx, dz] = FACING_DIRS[meta & 3];
      const ox = head ? x - dx : x + dx, oz = head ? z - dz : z + dz;
      return world.blockAt(ox, y, oz) === B.RED_BED;
    }
    default: {
      const def = block(id);
      if (def.shape === "cross" || isSapling(id)) return SOIL.has(below) || below === B.SAND && id === B.DEAD_BUSH;
      return belowDef.solid;
    }
  }
}

export class BlockRules {
  constructor(private world: World, private ctx: RuleContext) {
    world.delayFor = tickDelay;
  }

  /** Breaks a block as the world (no tool), dropping what it would drop by hand. */
  breakNaturally(x: number, y: number, z: number, drop = true): void {
    const id = this.world.blockAt(x, y, z);
    if (!id) return;
    const def = block(id);
    if (drop) {
      const meta = this.world.getMeta(x, y, z);
      let stacks = resolveDrops(def.drops, id, this.ctx.random);
      if (isCrop(id)) stacks = cropDrops(id, meta, this.ctx.random);
      // A door or bed drops once, from its lower half / foot.
      if (isDoor(id) && meta & 8) stacks = [];
      if (id === B.RED_BED && meta & 4) stacks = [];
      this.ctx.dropItems(x + 0.5, y + 0.3, z + 0.5, stacks);
    }
    this.world.setBlock(x, y, z, B.AIR, 0, "world");
  }

  onTick(x: number, y: number, z: number): void {
    const world = this.world;
    const id = world.getBlock(x, y, z);
    if (id <= 0) return;
    const def = block(id);
    if (isFluid(id)) { this.fluid(x, y, z, id); return; }
    if (def.gravity) {
      const below = world.getBlock(x, y - 1, z);
      if (below >= 0 && y > 0 && (below === 0 || isFluid(below) || block(below).replaceable)) {
        const meta = world.getMeta(x, y, z);
        world.setBlock(x, y, z, B.AIR, 0, "world");
        this.ctx.spawnFalling(x + 0.5, y, z + 0.5, id, meta);
      }
      return;
    }
    if (def.needsSupport && !supported(world, x, y, z, id, world.getMeta(x, y, z))) {
      this.breakNaturally(x, y, z);
      return;
    }
    if (id === B.FARMLAND && block(world.blockAt(x, y + 1, z)).opaque) world.setBlock(x, y, z, B.DIRT);
    if (isLeaves(id) && world.getMeta(x, y, z) === 0 && !this.hasLogNear(x, y, z)) {
      this.breakNaturally(x, y, z);
      this.ctx.sound("leaves", x + 0.5, y + 0.5, z + 0.5, 0.3);
    }
  }

  /** A log came down: the leaves around it check, one by one over the next few seconds, whether they still have a tree. */
  logRemoved(x: number, y: number, z: number): void {
    for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      if (isLeaves(this.world.blockAt(x + dx, y + dy, z + dz))) {
        this.world.schedule(x + dx, y + dy, z + dz, 20 + Math.floor(this.ctx.random() * 180));
      }
    }
  }

  private hasLogNear(x: number, y: number, z: number): boolean {
    for (let dy = -4; dy <= 4; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      const id = this.world.getBlock(x + dx, y + dy, z + dz);
      if (id < 0 || isLog(id)) return true;
    }
    return false;
  }

  // ---- fluids ---------------------------------------------------------------------

  private canReplace(id: number, fluid: number): boolean {
    if (id === 0) return true;
    if (isFluid(id)) return false;
    const def = block(id);
    // Water washes away dust, rails, torches, levers, buttons and diodes, as it does plants.
    if (def.shape === "wire" || def.shape === "rail" || isRedstoneTorch(id) || id === B.LEVER || isButton(id) || id === B.REPEATER || id === B.COMPARATOR) return true;
    return !def.solid && id !== B.LADDER && !isDoor(id) && (def.replaceable || def.shape === "cross" || def.shape === "crop" || id === B.TORCH || id === B.SNOW)
      && !(fluid === B.WATER && id === B.LILY_PAD);
  }

  private flowInto(x: number, y: number, z: number, fluid: number, meta: number): void {
    const world = this.world;
    const cur = world.getBlock(x, y, z);
    if (cur < 0) return;
    if (cur !== 0 && !isFluid(cur)) {
      const def = block(cur);
      this.ctx.dropItems(x + 0.5, y + 0.3, z + 0.5, resolveDrops(def.drops, cur, this.ctx.random));
    }
    world.setBlock(x, y, z, fluid, meta, "world");
  }

  private fluid(x: number, y: number, z: number, id: number): void {
    const world = this.world;
    const water = id === B.WATER;
    const step = water ? 1 : 2;
    let meta = world.getMeta(x, y, z);
    let level = meta & 7;
    const falling = (meta & 8) !== 0;

    // Lava touching water hardens: sources to obsidian, flows to cobblestone.
    if (!water) {
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
        if (world.blockAt(x + dx, y + dy, z + dz) === B.WATER) {
          world.setBlock(x, y, z, level === 0 && !falling ? B.OBSIDIAN : B.COBBLE, 0, "world");
          this.ctx.sound("fizz", x + 0.5, y + 0.5, z + 0.5, 0.5);
          return;
        }
      }
    }

    // A flowing block recomputes its level from what feeds it.
    if (level !== 0 || falling) {
      let next: number;
      if (world.blockAt(x, y + 1, z) === id) next = 8; // falling column
      else {
        let best = 99, sources = 0;
        for (const [dx, dz] of FACING_DIRS) {
          const n = world.blockAt(x + dx, y, z + dz);
          if (n !== id) continue;
          const nm = world.getMeta(x + dx, y, z + dz);
          const nl = nm & 8 ? 0 : nm & 7;
          if ((nm & 15) === 0) sources++;
          best = Math.min(best, nl);
        }
        const below = world.blockAt(x, y - 1, z);
        // Two sources side by side over solid ground make a third: infinite water.
        if (water && sources >= 2 && (block(below).solid || (below === B.WATER && (world.getMeta(x, y - 1, z) & 15) === 0))) next = 0;
        else {
          const lvl = best === 99 ? 99 : best + step;
          // Nothing feeds it any more (or only from too far away): it drains.
          if (lvl > 7) {
            world.setBlock(x, y, z, B.AIR, 0, "world");
            return;
          }
          next = lvl;
        }
      }
      if (next !== meta) {
        world.setBlock(x, y, z, id, next, "world");
        meta = next;
        level = meta & 7;
      }
    }

    // Down first.
    const below = world.getBlock(x, y - 1, z);
    if (below < 0) return;
    if (below === (water ? B.LAVA : B.WATER)) {
      world.setBlock(x, y - 1, z, water ? ((world.getMeta(x, y - 1, z) & 15) === 0 ? B.OBSIDIAN : B.COBBLE) : B.STONE, 0, "world");
      this.ctx.sound("fizz", x + 0.5, y - 0.5, z + 0.5, 0.5);
      return;
    }
    const canFall = y > 0 && (this.canReplace(below, id) || (below === id && (world.getMeta(x, y - 1, z) & 15) !== 0 && (world.getMeta(x, y - 1, z) & 8) === 0));
    if (canFall) {
      this.flowInto(x, y - 1, z, id, 8);
      if (level !== 0 || (meta & 8)) return;
    }

    // Then sideways, preferring the direction of the nearest drop.
    const spread = ((meta & 8) ? 0 : level) + step;
    if (spread > 7) return;
    const dirs = this.flowDirections(x, y, z, id, water ? 4 : 2);
    for (const d of dirs) {
      const [dx, dz] = FACING_DIRS[d];
      const nx = x + dx, nz = z + dz;
      const n = world.getBlock(nx, y, nz);
      if (n < 0) continue;
      if (n === (water ? B.LAVA : B.WATER)) {
        if (water) {
          world.setBlock(nx, y, nz, (world.getMeta(nx, y, nz) & 15) === 0 ? B.OBSIDIAN : B.COBBLE, 0, "world");
          this.ctx.sound("fizz", nx + 0.5, y + 0.5, nz + 0.5, 0.5);
        }
        continue;
      }
      if (n === id) {
        const nm = world.getMeta(nx, y, nz);
        if ((nm & 15) === 0 || nm & 8 || (nm & 7) <= spread) continue;
        world.setBlock(nx, y, nz, id, spread, "world");
        continue;
      }
      if (this.canReplace(n, id)) this.flowInto(nx, y, nz, id, spread);
    }
  }

  /** Horizontal directions that lead soonest to somewhere the fluid can fall; all open ones if none. */
  private flowDirections(x: number, y: number, z: number, id: number, reach: number): number[] {
    const open: number[] = [];
    let best = 99;
    const dist: number[] = [99, 99, 99, 99];
    for (let d = 0; d < 4; d++) {
      const [dx, dz] = FACING_DIRS[d];
      const n = this.world.getBlock(x + dx, y, z + dz);
      if (n < 0 || !(this.canReplace(n, id) || n === id || isFluid(n))) continue;
      if (n === id && (this.world.getMeta(x + dx, y, z + dz) & 15) === 0) continue;
      open.push(d);
      dist[d] = this.dropDistance(x + dx, y, z + dz, id, reach, OPPOSITE_FACING[d]);
      best = Math.min(best, dist[d]);
    }
    if (best === 99) return open;
    return open.filter((d) => dist[d] === best);
  }

  private dropDistance(x: number, y: number, z: number, id: number, reach: number, from: number): number {
    const seen = new Set<string>();
    let frontier: [number, number, number][] = [[x, z, 1]];
    while (frontier.length) {
      const next: [number, number, number][] = [];
      for (const [cx, cz, d] of frontier) {
        const below = this.world.getBlock(cx, y - 1, cz);
        if (below >= 0 && (this.canReplace(below, id) || below === id)) return d;
        if (d >= reach) continue;
        for (let k = 0; k < 4; k++) {
          if (d === 1 && k === from) continue;
          const [dx, dz] = FACING_DIRS[k];
          const nx = cx + dx, nz = cz + dz, key = `${nx},${nz}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const n = this.world.getBlock(nx, y, nz);
          if (n >= 0 && (this.canReplace(n, id) || n === id)) next.push([nx, nz, d + 1]);
        }
      }
      frontier = next;
    }
    return 99;
  }

  // ---- random ticks -------------------------------------------------------------------

  /** Picks random blocks in loaded chunks near the players and lets them grow, spread or melt. */
  randomTicks(centres: { x: number; z: number }[], radiusChunks: number, perSection = 3): void {
    const world = this.world;
    const seen = new Set<number>();
    for (const c of centres) {
      const pcx = Math.floor(c.x) >> 4, pcz = Math.floor(c.z) >> 4;
      for (let cz = pcz - radiusChunks; cz <= pcz + radiusChunks; cz++) {
        for (let cx = pcx - radiusChunks; cx <= pcx + radiusChunks; cx++) {
          const chunk = world.chunk(cx, cz);
          if (!chunk || seen.has(chunk.id)) continue;
          seen.add(chunk.id);
          for (let section = 0; section < WORLD_HEIGHT / 16; section++) {
            for (let i = 0; i < perSection; i++) {
              const r = (this.ctx.random() * 4096) | 0;
              const lx = r & 15, lz = (r >> 4) & 15, ly = section * 16 + (r >> 8);
              const id = chunk.blocks[blockIndex(lx, ly, lz)];
              if (id === 0 || id === B.STONE || id === B.DEEPSLATE || id === B.WATER) continue;
              this.randomTick(cx * 16 + lx, ly, cz * 16 + lz, id, chunk.biomes[lz * 16 + lx]);
            }
          }
        }
      }
    }
  }

  private light(x: number, y: number, z: number): number {
    const l = this.world.getLight(x, y, z);
    return l < 0 ? 0 : Math.max(l >> 4, l & 15);
  }

  private randomTick(x: number, y: number, z: number, id: number, biome: number): void {
    const world = this.world;
    const rand = this.ctx.random;
    if (isCrop(id)) {
      const age = world.getMeta(x, y, z);
      if (age < CROP_MAX_AGE[id] && this.light(x, y + 1, z) >= 9) {
        const wet = world.getMeta(x, y - 1, z) > 0;
        if (rand() < (wet ? 1 / 3 : 1 / 6)) world.setMeta(x, y, z, age + 1);
      }
      return;
    }
    if (isSapling(id)) {
      if (this.light(x, y + 1, z) >= 9 && rand() < 1 / 7) this.growTree(x, y, z, id);
      return;
    }
    switch (id) {
      case B.GRASS: {
        const above = world.blockAt(x, y + 1, z);
        if (block(above).opaque || isFluid(above)) { world.setBlock(x, y, z, B.DIRT); return; }
        if (this.light(x, y + 1, z) < 9) return;
        for (let i = 0; i < 4; i++) {
          const tx = x + Math.floor(rand() * 3) - 1, ty = y + Math.floor(rand() * 5) - 3, tz = z + Math.floor(rand() * 3) - 1;
          if (world.blockAt(tx, ty, tz) === B.DIRT && !block(world.blockAt(tx, ty + 1, tz)).opaque && !isFluid(world.blockAt(tx, ty + 1, tz)) && this.light(tx, ty + 1, tz) >= 4) {
            world.setBlock(tx, ty, tz, B.GRASS);
          }
        }
        return;
      }
      case B.SUGAR_CANE: case B.CACTUS: {
        if (world.blockAt(x, y + 1, z) !== 0 || rand() > 1 / 10) return;
        let h = 1;
        while (h < 3 && world.blockAt(x, y - h, z) === id) h++;
        if (h < 3) {
          world.setBlock(x, y + 1, z, id);
          if (id === B.CACTUS && !supported(world, x, y + 1, z, id, 0)) this.breakNaturally(x, y + 1, z);
        }
        return;
      }
      case B.ICE: case B.SNOW: {
        const l = world.getLight(x, y, z);
        const blockLight = Math.max(l & 15, ...[[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => world.getLight(x + dx, y + dy, z + dz) & 15));
        if (blockLight > 11) world.setBlock(x, y, z, id === B.ICE ? B.WATER : B.AIR);
        return;
      }
      case B.FARMLAND: {
        const wet = this.waterNear(x, y, z);
        const m = world.getMeta(x, y, z);
        if (wet && m < 7) world.setMeta(x, y, z, 7);
        else if (!wet) {
          if (m > 0) world.setMeta(x, y, z, m - 1);
          else if (!isCrop(world.blockAt(x, y + 1, z))) world.setBlock(x, y, z, B.DIRT);
        }
        return;
      }
    }
    // Snow settles and water freezes in cold biomes when it snows.
    if (biomeDef(biome).snowy && this.ctx.isRaining() && rand() < 0.1) {
      const top = world.topSolid(x, z);
      if (top >= 0 && world.seesSky(x, top + 1, z)) {
        const t = world.blockAt(x, top, z);
        if (t === B.WATER && (world.getMeta(x, top, z) & 15) === 0) world.setBlock(x, top, z, B.ICE);
        else if (block(t).opaque && world.blockAt(x, top + 1, z) === 0) world.setBlock(x, top + 1, z, B.SNOW);
      }
    }
  }

  private waterNear(x: number, y: number, z: number): boolean {
    for (let dy = 0; dy <= 1; dy++) for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) {
      if (this.world.blockAt(x + dx, y + dy, z + dz) === B.WATER) return true;
    }
    return this.ctx.isRaining() && this.world.seesSky(x, y + 1, z);
  }

  /** Grows a sapling if its tree fits. Returns whether it grew. */
  growTree(x: number, y: number, z: number, saplingId: number): boolean {
    const world = this.world;
    const rng = new Rng((this.ctx.random() * 0x7fffffff) | 0);
    const kind = saplingTree(saplingId, rng);
    for (let dy = 1; dy <= 5; dy++) if (block(world.blockAt(x, y + dy, z)).solid) return false;
    world.setBlock(x, y, z, B.AIR);
    const place: Place = (px, py, pz, id, m = 0, force = false) => {
      if (py < 1 || py >= WORLD_HEIGHT) return;
      const cur = world.getBlock(px, py, pz);
      if (cur < 0) return;
      if (id === B.DIRT) { if (cur === B.GRASS) world.setBlock(px, py, pz, B.DIRT); return; }
      if (cur === 0 || block(cur).replaceable || (force && isLeaves(cur)) || isSapling(cur)) world.setBlock(px, py, pz, id, m);
    };
    buildTree(kind, place, x, y, z, rng);
    return true;
  }

  /** Bone meal: pushes a crop or sapling along, or sprouts grass and flowers. */
  boneMeal(x: number, y: number, z: number): boolean {
    const world = this.world;
    const id = world.blockAt(x, y, z);
    const rand = this.ctx.random;
    if (isCrop(id)) {
      const age = world.getMeta(x, y, z);
      if (age >= CROP_MAX_AGE[id]) return false;
      world.setMeta(x, y, z, Math.min(CROP_MAX_AGE[id], age + 2 + Math.floor(rand() * 3)));
      return true;
    }
    if (isSapling(id)) {
      if (rand() < 0.45) this.growTree(x, y, z, id);
      return true;
    }
    if (id === B.GRASS) {
      for (let i = 0; i < 24; i++) {
        const tx = x + Math.round((rand() - 0.5) * 6), tz = z + Math.round((rand() - 0.5) * 6);
        for (let ty = y + 2; ty >= y - 2; ty--) {
          if (world.blockAt(tx, ty, tz) === B.GRASS && world.blockAt(tx, ty + 1, tz) === 0) {
            const flowers = [B.DANDELION, B.POPPY, B.OXEYE_DAISY, B.CORNFLOWER];
            world.setBlock(tx, ty + 1, tz, rand() < 0.85 ? B.SHORT_GRASS : flowers[Math.floor(rand() * flowers.length)]);
            break;
          }
        }
      }
      return true;
    }
    return false;
  }
}

/** Crops drop more when grown, and their seed when not — the whole farming loop hangs on this. */
export function cropDrops(id: number, age: number, random: () => number): ItemStack[] {
  const ripe = age >= CROP_MAX_AGE[id];
  const seedsFor = (n: number) => {
    let c = 0;
    for (let i = 0; i < n; i++) if (random() < 0.57) c++;
    return c;
  };
  const itemId = (name: string) => itemByName(name).id;
  if (id === B.WHEAT) {
    const out: ItemStack[] = [{ id: itemId("wheat_seeds"), count: ripe ? 1 + seedsFor(3) : 1 }];
    if (ripe) out.push({ id: itemId("wheat"), count: 1 });
    return out;
  }
  const name = id === B.CARROTS ? "carrot" : "potato";
  return [{ id: itemId(name), count: ripe ? 1 + seedsFor(3) : 1 }];
}

