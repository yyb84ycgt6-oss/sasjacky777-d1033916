/**
 * One running world: the loop that ties the engine, the renderer, the audio,
 * saving and the network together.
 *
 * The simulation runs at a fixed 20 ticks a second and the renderer
 * interpolates between ticks, so the game plays identically at 30 fps on a
 * phone and 144 on a desktop. A tab in the background is throttled by the
 * browser; when it comes back, at most five ticks are caught up so a long
 * absence does not freeze the tab replaying minutes of world.
 *
 * Role decides who owns the world. "local" and "host" simulate everything:
 * block rules, mobs, weather, time. A "guest" simulates only its own player
 * and asks the host for everything else, so there is exactly one answer to
 * where the water went.
 */
import { B, block, isFluid, isLeaves, isLog, type Material } from "../engine/blocks";
import { chunkId, newChest, newFurnace, type BlockEntity, type Chunk, type FurnaceEntity } from "../engine/chunk";
import { DAY_TICKS, SEA_LEVEL, TICK_MS, WORLD_HEIGHT } from "../engine/constants";
import { BlockRules, tickDelay } from "../engine/blockRules";
import { COOK_TICKS, fuelTicks, smeltResult } from "../engine/crafting";
import {
  bumpEntityIds, FallingBlock, ItemEntity, PrimedTnt, XpOrb, xpOrbValues,
  type DamageSource, type Entity, type EntityContext, type EntitySnapshot, type PlayerRef,
} from "../engine/entities";
import { blastImpact, explosionBlocks, exposure } from "../engine/explosion";
import { itemDef, itemId, maxStack, resolveDrops, type ItemStack } from "../engine/items";
import { Mob, MOB_KINDS, type MobKind } from "../engine/mobs";
import { groundBlock } from "../engine/physics";
import { Player, type PlayerEvent } from "../engine/player";
import { Generator } from "../engine/worldgen";
import { buildAtlas } from "../engine/atlas";
import { WorkerPool } from "../engine/workerPool";
import { World, type BlockChange } from "../engine/world";
import { biomeDef } from "../engine/biomes";
import { GameAudio } from "../audio";
import { WorldRenderer, type RemotePlayerView } from "../render/renderer";
import { Actions } from "./actions";
import { runCommand } from "./commands";
import { SaveStore, type ChunkData, type WorldMeta } from "./save";
import { effectiveControls, saveSettings, type Settings } from "./settings";
import { Store } from "./store";
import { Streamer } from "./streamer";
import { emptyControls, type ChatLine, type Controls, type Hud, type Screen } from "./types";
import type { Slot } from "../engine/inventory";

export type Role = "local" | "host" | "guest";

/** What the game needs from an online session. Implemented by net/session.ts. */
export interface NetLink {
  readonly role: "host" | "guest";
  readonly room: string;
  readonly kind: "online" | "device";
  tick(): void;
  blockChanged(change: BlockChange): void;
  chat(text: string): void;
  // guest → host
  requestChunk(cx: number, cz: number): Promise<ChunkData | null>;
  isModified(cx: number, cz: number): boolean;
  attack(entityId: number, damage: number, fromX: number, fromZ: number): void;
  interact(entityId: number, item: string | null): void;
  drops(x: number, y: number, z: number, stacks: ItemStack[], xp: number): void;
  throwItem(kind: "arrow" | "snowball" | "egg", x: number, y: number, z: number, vx: number, vy: number, vz: number): void;
  primeTnt(x: number, y: number, z: number, fuse: number): void;
  blockEntity(x: number, y: number, z: number, e: BlockEntity | null): void;
  sleeping(on: boolean): void;
  chunkLoaded?(cx: number, cz: number, fromSave: boolean): void;
  // host → guests
  hurtRemote(id: string, amount: number, source: DamageSource, fx: number, fz: number, kb: number): void;
  giveRemote(id: string, stack: ItemStack): void;
  xpRemote(id: string, amount: number): void;
  effect(kind: "sound" | "particles" | "explosion", data: unknown[]): void;
  close(): void;
}

export interface RemotePlayer {
  id: string;
  name: string;
  x: number; y: number; z: number;
  yaw: number; pitch: number;
  px: number; py: number; pz: number; pyaw: number;
  walk: number; speed: number;
  swing: number;
  sneaking: boolean;
  held: number | null;
  variant: number;
  hurt: boolean;
  dead: boolean;
  gameMode: string;
  sleeping: boolean;
  lastSeen: number;
  receivedAt: number;
}

export interface GameOptions {
  meta: WorldMeta;
  canvas: HTMLCanvasElement;
  settings: Settings;
  saves: SaveStore;
  playerId: string;
  playerName: string;
  role: Role;
}

const AUTOSAVE_TICKS = 600;
const MAX_HOSTILE = 14;
const MAX_PASSIVE = 10;

export class Game {
  readonly meta: WorldMeta;
  readonly role: Role;
  settings: Settings;
  readonly world = new World();
  readonly generator: Generator;
  readonly pool: WorkerPool;
  readonly renderer: WorldRenderer;
  readonly audio = new GameAudio();
  readonly streamer: Streamer;
  readonly rules: BlockRules;
  readonly saves: SaveStore;
  readonly player: Player;
  readonly controls: Controls = emptyControls();
  readonly entities = new Map<number, Entity>();
  readonly remote = new Map<string, RemotePlayer>();
  readonly store: Store<Hud>;
  readonly actions: Actions;
  net: NetLink | null = null;

  time: number;
  rain = 0;
  thunder = 0;
  lightning = 0;
  tickCount = 0;
  screen: Screen | null = null;
  cursor: Slot = null;
  craftGrid: Slot[] = [null, null, null, null];
  perspective: 0 | 1 | 2 = 0;
  hudHidden = false;
  debug = false;
  hurtTilt = 0;
  lastHurtAt = 0;
  private running = false;
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private fps = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private hudTimer = 0;
  private chatLines: ChatLine[] = [];
  private chatId = 0;
  private dirtySave = new Set<number>();
  private unloaded = new Map<number, ChunkData>();
  private saveTimer = 0;
  private savingNow = false;
  private stepDist = 0;
  private spawnPlaced = false;
  private startedAt = performance.now();
  private playTimeBase: number;
  private title: Hud["title"] = null;
  private actionbar: Hud["actionbar"] = null;
  private heldNameAt = 0;
  private lastSelected = -1;
  private lastHeldId: number | null = null;
  private sleepCounter = 0;
  private unsubscribers: (() => void)[] = [];
  onExit: (() => void) | null = null;
  /** Called when the world can no longer continue (lost host, fatal error), with words for the screen. */
  onFatal: ((message: string) => void) | null = null;
  readonly ctx: EntityContext;

  constructor(opts: GameOptions) {
    this.meta = opts.meta;
    this.role = opts.role;
    this.settings = opts.settings;
    this.saves = opts.saves;
    this.time = opts.meta.time;
    this.rain = opts.meta.weather.rain;
    this.thunder = opts.meta.weather.thunder;
    this.playTimeBase = opts.meta.playTime;
    this.generator = new Generator({ seed: opts.meta.seed, type: opts.meta.type });
    this.world.simulates = opts.role !== "guest";
    this.world.delayFor = tickDelay;

    const atlas = buildAtlas();
    this.pool = new WorkerPool({ kind: "init", settings: { seed: opts.meta.seed, type: opts.meta.type }, layers: atlas.layers });
    const pixelRatio = Math.min(window.devicePixelRatio || 1, opts.settings.maxPixelRatio);
    this.renderer = new WorldRenderer(opts.canvas, this.world, pixelRatio);

    this.player = new Player(opts.playerId, opts.playerName);
    this.player.setGameMode(opts.meta.gameMode);
    if (opts.meta.player) this.player.load(opts.meta.player);
    else {
      const s = this.worldSpawn();
      this.player.body.x = s.x; this.player.body.y = s.y; this.player.body.z = s.z;
      this.needsSurface = true;
    }
    this.player.name = opts.playerName;

    this.ctx = this.makeContext();
    this.rules = new BlockRules(this.world, {
      dropItems: (x, y, z, stacks) => { for (const s of stacks) this.dropItem(x, y, z, s); },
      spawnFalling: (x, y, z, id, meta) => this.spawn(new FallingBlock(x, y, z, id, meta)),
      sound: (name, x, y, z, v, p) => this.sound(name, x, y, z, v, p),
      isRaining: () => this.rain > 0.5,
      random: Math.random,
    });

    this.streamer = new Streamer(
      this.world, this.pool,
      { load: (cx, cz) => this.loadChunk(cx, cz), unload: (c) => this.unloadChunk(c) },
      { setChunk: (id, cx, cz, mesh) => this.renderer.setChunk(id, cx, cz, mesh), removeChunk: (id) => this.renderer.removeChunk(id) },
      opts.settings.renderDistance,
      (chunk, fromSave) => this.net?.chunkLoaded?.(chunk.cx, chunk.cz, fromSave),
    );
    this.applySettings(opts.settings);

    for (const s of opts.meta.entities ?? []) this.restoreEntity(s);

    this.store = new Store<Hud>(this.hudSnapshot());
    this.actions = new Actions(this);

    this.unsubscribers.push(this.world.onChange((c) => this.onBlockChange(c)));
    if (this.saves.problem) this.message(this.saves.problem, "#ffcc55");
  }

  // ---- lifecycle --------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    document.addEventListener("visibilitychange", this.syncBackground);
    this.syncBackground();
    const loop = (t: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      try {
        this.frame(t);
      } catch (err) {
        // One bad frame must not take the tab down, but it must not be silent either.
        console.error("[blockcraft] frame failed", err);
        this.message(`Something went wrong this frame: ${(err as Error).message}`, "#ff6666");
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  async stop(save = true): Promise<void> {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.syncBackground);
    if (this.backgroundTimer) clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
    if (save && this.role !== "guest") await this.saveNow().catch((e: Error) => console.error("[blockcraft] final save failed", e));
    this.net?.close();
    this.net = null;
    for (const u of this.unsubscribers) u();
    this.pool.dispose();
    this.renderer.dispose();
    this.audio.dispose();
  }

  applySettings(s: Settings): void {
    this.settings = s;
    saveSettings(s);
    if (this.streamer.radius !== s.renderDistance) this.streamer.setRadius(s.renderDistance);
    const fancy = s.graphics === "fancy";
    if (this.streamer.fancyLeaves !== fancy || this.streamer.smoothLighting !== s.smoothLighting) {
      this.streamer.fancyLeaves = fancy;
      this.streamer.smoothLighting = s.smoothLighting;
      this.streamer.invalidate();
    }
    this.renderer.shared.uGamma.value = s.brightness;
    this.renderer.particles.budget = s.particles === "all" ? 1 : s.particles === "decreased" ? 0.5 : 0.15;
    this.audio.volumes = { master: s.masterVolume, sfx: s.soundVolume, music: s.musicVolume };
    this.audio.applyVolumes();
    this.resize();
  }

  resize(): void {
    const c = this.renderer.canvas;
    const w = c.clientWidth || window.innerWidth, h = c.clientHeight || window.innerHeight;
    this.renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio));
  }

  get isMobile(): boolean {
    return effectiveControls(this.settings) === "mobile";
  }

  get simulates(): boolean {
    return this.role !== "guest";
  }

  // ---- chunks ---------------------------------------------------------------------------

  private async loadChunk(cx: number, cz: number): Promise<ChunkData | null> {
    const id = chunkId(cx, cz);
    const pending = this.unloaded.get(id);
    if (pending) return { ...pending, blocks: pending.blocks.slice(), meta: pending.meta.slice() };
    if (this.role === "guest") {
      if (this.net && this.net.isModified(cx, cz)) return this.net.requestChunk(cx, cz);
      return null;
    }
    return this.saves.getChunk(this.meta.id, cx, cz);
  }

  private unloadChunk(c: Chunk): void {
    if (this.role === "guest") return;
    // Kept in memory until the save lands, so walking straight back never
    // reads the older copy from disk.
    const data = this.chunkData(c);
    this.unloaded.set(c.id, data);
    this.dirtySave.delete(c.id);
    void this.saves.putChunks(this.meta.id, [data])
      .then(() => { if (this.unloaded.get(c.id) === data) this.unloaded.delete(c.id); })
      .catch((e: Error) => this.message(`Could not save part of the world: ${e.message}`, "#ff6666"));
  }

  chunkData(c: Chunk): ChunkData {
    return { cx: c.cx, cz: c.cz, blocks: c.blocks.slice(), meta: c.meta.slice(), entities: [...c.entities.entries()].map(([i, e]) => [i, structuredClone(e)]) };
  }

  /** Current contents of a chunk if this game holds it (loaded or awaiting save) — the host answers guests from this. */
  async chunkForGuest(cx: number, cz: number): Promise<ChunkData | null> {
    const c = this.world.chunk(cx, cz);
    if (c) return this.chunkData(c);
    const pending = this.unloaded.get(chunkId(cx, cz));
    if (pending) return pending;
    return this.saves.getChunk(this.meta.id, cx, cz);
  }

  // ---- entities -----------------------------------------------------------------------------

  spawn(e: Entity): void {
    if (!this.simulates) return;
    this.entities.set(e.id, e);
  }

  dropItem(x: number, y: number, z: number, stack: ItemStack, vx?: number, vy?: number, vz?: number, thrower: string | null = null, delay = 10): void {
    if (stack.count <= 0) return;
    if (this.role === "guest") {
      this.net?.drops(x, y, z, [stack], 0);
      return;
    }
    const e = new ItemEntity(x, y, z, { ...stack }, delay);
    e.body.vx = vx ?? (Math.random() - 0.5) * 0.2;
    e.body.vy = vy ?? 0.2;
    e.body.vz = vz ?? (Math.random() - 0.5) * 0.2;
    e.thrower = thrower;
    this.spawn(e);
  }

  spawnXp(x: number, y: number, z: number, amount: number): void {
    if (amount <= 0) return;
    if (this.role === "guest") { this.net?.drops(x, y, z, [], amount); return; }
    for (const v of xpOrbValues(amount)) this.spawn(new XpOrb(x, y, z, v));
  }

  private restoreEntity(s: EntitySnapshot): void {
    let e: Entity | null = null;
    if (MOB_KINDS.includes(s.kind as MobKind)) {
      const m = new Mob(s.kind as MobKind, s.x, s.y, s.z, s.id);
      m.applySnapshot(s);
      e = m;
    } else if (s.kind === "item") {
      const st = s.data?.stack as ItemStack | undefined;
      if (st && itemDef(st.id)) e = new ItemEntity(s.x, s.y, s.z, st, 0, s.id);
    } else if (s.kind === "xp") {
      e = new XpOrb(s.x, s.y, s.z, Number(s.data?.value ?? 1), s.id);
    }
    if (e) {
      bumpEntityIds(e.id);
      this.entities.set(e.id, e);
    }
  }

  private makeContext(): EntityContext {
    // The getters below run with `this` bound to the object literal, so they need the game by name.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    return {
      world: this.world,
      get tick() { return game.tickCount; },
      get daylight() { return game.daylight(); },
      get difficulty() { return game.meta.difficulty; },
      random: Math.random,
      players: () => this.playerRefs(),
      hurtPlayer: (id, amount, source, fx, fz, kb) => {
        if (id === this.player.id) this.hurtLocal(amount, source, fx, fz, kb);
        else this.net?.hurtRemote(id, amount, source, fx, fz, kb);
      },
      givePlayer: (id, stack) => {
        if (id === this.player.id) {
          const left = this.player.inventory.add(stack);
          if (left < stack.count) this.bumpInv();
          return left;
        }
        this.net?.giveRemote(id, stack);
        return 0;
      },
      giveXp: (id, amount) => {
        if (id === this.player.id) this.addXp(amount);
        else this.net?.xpRemote(id, amount);
      },
      spawn: (e) => this.spawn(e),
      dropItem: (x, y, z, stack, vx, vy, vz) => this.dropItem(x, y, z, stack, vx, vy, vz),
      explode: (x, y, z, power, cause) => this.explode(x, y, z, power, cause),
      sound: (name, x, y, z, v, p) => this.sound(name, x, y, z, v, p),
      particles: (kind, x, y, z, count, data) => this.particles(kind, x, y, z, count, data),
      entitiesNear: (x, y, z, r) => {
        const out: Entity[] = [];
        for (const e of this.entities.values()) {
          if (Math.abs(e.x - x) <= r && Math.abs(e.y - y) <= r && Math.abs(e.z - z) <= r) out.push(e);
        }
        return out;
      },
      placeBlock: (x, y, z, id, meta) => this.world.setBlock(x, y, z, id, meta, "world"),
    };
  }

  playerRefs(): PlayerRef[] {
    const p = this.player;
    const refs: PlayerRef[] = [];
    if (!p.dead) {
      refs.push({
        id: p.id, name: p.name, x: p.body.x, y: p.body.y, z: p.body.z, width: p.body.width, height: p.body.height,
        targetable: p.survivalLike, heldItem: p.inventory.held?.id ?? -1, sneaking: p.sneaking,
      });
    }
    for (const r of this.remote.values()) {
      if (r.dead) continue;
      refs.push({
        id: r.id, name: r.name, x: r.x, y: r.y, z: r.z, width: 0.6, height: r.sneaking ? 1.5 : 1.8,
        targetable: r.gameMode === "survival" || r.gameMode === "adventure", heldItem: r.held ?? -1, sneaking: r.sneaking,
      });
    }
    return refs;
  }

  // ---- effects ---------------------------------------------------------------------------

  sound(name: string, x: number | null, y = 0, z = 0, volume = 1, pitch = 1): void {
    this.audio.play(name, x, y, z, volume, pitch);
    // A local world opened to others mid-game is hosting too: the link, not the role it started with, decides.
    if (x !== null) this.net?.effect("sound", [name, round2(x), round2(y), round2(z), volume, pitch]);
  }

  blockSound(material: Material, kind: "dig" | "break" | "place" | "step", x: number, y: number, z: number, broadcast = true): void {
    this.audio.block(material, kind, x, y, z);
    if (broadcast && kind !== "step" && kind !== "dig" && this.net) this.net.effect("sound", [`block:${material}:${kind}`, round2(x), round2(y), round2(z), 1, 1]);
  }

  particles(kind: string, x: number, y: number, z: number, count = 1, data = 0, broadcast = true): void {
    this.renderer.particles.emit(kind, x, y, z, count, data);
    if (broadcast) this.net?.effect("particles", [kind, round2(x), round2(y), round2(z), count, data]);
  }

  explode(x: number, y: number, z: number, power: number, cause: Entity | null): void {
    if (!this.simulates) return;
    this.sound("explode", x, y, z, 1, 0.9 + Math.random() * 0.2);
    this.particles("explosion", x, y, z, 24, 0, false);
    this.net?.effect("explosion", [round2(x), round2(y), round2(z), power]);
    const griefing = this.meta.rules.mobGriefing || !(cause instanceof Mob);
    if (griefing) {
      for (const [bx, by, bz] of explosionBlocks(this.world, x, y, z, power, Math.random)) {
        const id = this.world.blockAt(bx, by, bz);
        if (!id || id === B.BEDROCK) continue;
        if (id === B.TNT) {
          this.world.setBlock(bx, by, bz, B.AIR, 0, "world");
          this.spawn(new PrimedTnt(bx + 0.5, by, bz + 0.5, 10 + Math.floor(Math.random() * 20)));
          continue;
        }
        const def = block(id);
        if (Math.random() < 1 / power) {
          for (const s of resolveDrops(def.drops, id, Math.random)) this.dropItem(bx + 0.5, by + 0.5, bz + 0.5, s);
        }
        this.dropContainerContents(bx, by, bz);
        this.world.setBlock(bx, by, bz, B.AIR, 0, "world");
        if (isLog(id)) this.rules.logRemoved(bx, by, bz);
      }
    }
    // Entities and players in range.
    for (const e of this.entities.values()) {
      if (e === cause || e.removed) continue;
      const box = e.box();
      const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2, cz = (box.minZ + box.maxZ) / 2;
      const d = Math.hypot(cx - x, cy - y, cz - z);
      const hit = blastImpact(power, d, exposure(this.world, x, y, z, box));
      if (hit.damage <= 0) continue;
      if (e instanceof Mob) e.hurt(this.ctx, hit.damage, "explosion", x, z);
      else if (e instanceof ItemEntity || e instanceof XpOrb) { if (hit.damage > 4) e.removed = true; }
      const n = d || 1;
      e.body.vx += ((cx - x) / n) * hit.push; e.body.vy += ((cy - y) / n) * hit.push; e.body.vz += ((cz - z) / n) * hit.push;
    }
    for (const p of this.playerRefs()) {
      const box = { minX: p.x - 0.3, minY: p.y, minZ: p.z - 0.3, maxX: p.x + 0.3, maxY: p.y + p.height, maxZ: p.z + 0.3 };
      const d = Math.hypot(p.x - x, p.y + p.height / 2 - y, p.z - z);
      const hit = blastImpact(power, d, exposure(this.world, x, y, z, box));
      if (hit.damage > 0) this.ctx.hurtPlayer(p.id, hit.damage, "explosion", x, z, hit.push);
    }
  }

  // ---- blocks ------------------------------------------------------------------------------

  private onBlockChange(c: BlockChange): void {
    const chunk = this.world.chunkAt(c.x, c.z);
    if (chunk) this.dirtySave.add(chunk.id);
    if (c.cause !== "remote") this.net?.blockChanged(c);
    if (this.simulates && isLog(c.prevId) && c.id !== c.prevId) this.rules.logRemoved(c.x, c.y, c.z);
  }

  /** Spills a chest or furnace's contents when it is broken. */
  dropContainerContents(x: number, y: number, z: number): void {
    const e = this.world.getEntity(x, y, z);
    if (!e) return;
    const stacks = e.kind === "chest" ? e.items : [e.input, e.fuel, e.output];
    for (const s of stacks) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s);
    if (e.kind === "furnace" && e.xp > 0) this.spawnXp(x + 0.5, y + 0.5, z + 0.5, Math.floor(e.xp));
    this.world.setEntity(x, y, z, undefined);
  }

  containerAt(x: number, y: number, z: number, kind: "chest" | "furnace"): BlockEntity {
    let e = this.world.getEntity(x, y, z);
    if (!e || e.kind !== kind) {
      e = kind === "chest" ? newChest() : newFurnace();
      this.world.setEntity(x, y, z, e);
    }
    return e;
  }

  /** A container changed from this client: save it and tell the others. */
  containerChanged(x: number, y: number, z: number): void {
    const c = this.world.chunkAt(x, z);
    if (c) { c.modified = true; this.dirtySave.add(c.id); }
    this.net?.blockEntity(x, y, z, this.world.getEntity(x, y, z) ?? null);
    this.bumpInv();
  }

  private tickFurnaces(): void {
    for (const c of this.world.loadedChunks()) {
      for (const [index, e] of c.entities) {
        if (e.kind !== "furnace") continue;
        const x = c.cx * 16 + (index & 15), z = c.cz * 16 + ((index >> 4) & 15), y = index >> 8;
        if (this.tickFurnace(e, x, y, z)) {
          c.modified = true;
          this.dirtySave.add(c.id);
          if (this.tickCount % 10 === 0) this.net?.blockEntity(x, y, z, e);
          if (this.screen?.kind === "furnace" && this.screen.x === x && this.screen.y === y && this.screen.z === z) this.bumpInv();
        }
      }
    }
  }

  /** One tick of a furnace, the original's rules: fuel burns only while there is something to smelt. Returns whether anything changed. */
  tickFurnace(f: FurnaceEntity, x: number, y: number, z: number): boolean {
    const wasLit = f.burn > 0;
    let changed = false;
    if (f.burn > 0) { f.burn--; changed = true; }
    const recipe = f.input ? smeltResult(f.input.id) : null;
    const outId = recipe ? itemId(recipe.output) : -1;
    const room = recipe && (!f.output || (f.output.id === outId && f.output.count < maxStack(outId)));
    if (recipe && room) {
      if (f.burn === 0 && f.fuel && fuelTicks(f.fuel.id) > 0) {
        f.burn = f.burnTotal = fuelTicks(f.fuel.id);
        const fuelDef = itemDef(f.fuel.id);
        f.fuel.count--;
        if (f.fuel.count <= 0) f.fuel = fuelDef?.name === "lava_bucket" ? { id: itemId("bucket"), count: 1 } : null;
        changed = true;
      }
      if (f.burn > 0) {
        f.cook++;
        changed = true;
        if (f.cook >= COOK_TICKS) {
          f.cook = 0;
          f.output = f.output ? { ...f.output, count: f.output.count + 1 } : { id: outId, count: 1 };
          f.xp += recipe.xp;
          f.input!.count--;
          if (f.input!.count <= 0) f.input = null;
        }
      } else if (f.cook > 0) { f.cook = Math.max(0, f.cook - 2); changed = true; }
    } else if (f.cook > 0) { f.cook = 0; changed = true; }
    const lit = f.burn > 0;
    if (lit !== wasLit) {
      const id = this.world.blockAt(x, y, z);
      if (id === B.FURNACE || id === B.LIT_FURNACE) {
        const meta = this.world.getMeta(x, y, z);
        const e = this.world.getEntity(x, y, z);
        this.world.setBlock(x, y, z, lit ? B.LIT_FURNACE : B.FURNACE, meta, "world");
        // setBlock clears the entity when the id changes; put the same one back.
        if (e) this.world.setEntity(x, y, z, e);
      }
    }
    return changed;
  }

  // ---- players ------------------------------------------------------------------------------

  hurtLocal(amount: number, source: DamageSource, fx?: number, fz?: number, kb = 0): void {
    if (!this.meta.rules.doFallDamage && source === "fall") return;
    const dealt = this.player.hurt(amount, source, fx, fz, kb);
    if (dealt > 0 || kb > 0) {
      this.lastHurtAt = performance.now();
      this.hurtTilt = 1;
    }
  }

  addXp(amount: number): void {
    const before = this.player.xpLevel;
    this.player.addXp(amount);
    if (this.player.xpLevel > before) this.sound("levelup", null, 0, 0, 0.6);
  }

  bumpInv(): void {
    this.store.set({ inv: this.store.get().inv + 1, hotbar: this.player.inventory.slots.slice(0, 9) });
  }

  message(text: string, color?: string): void {
    this.chatLines.push({ id: this.chatId++, text, color, at: performance.now() });
    if (this.chatLines.length > 100) this.chatLines.shift();
    this.store.set({ chat: this.chatLines.slice(-50) });
  }

  showTitle(text: string, sub?: string): void {
    this.title = { text, sub, at: performance.now() };
  }

  showActionbar(text: string): void {
    this.actionbar = { text, at: performance.now() };
  }

  /** Chat input: a command if it starts with "/", else a message to everyone. */
  submitChat(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (t.startsWith("/")) {
      const out = runCommand(this, t.slice(1));
      for (const line of out) this.message(line.text, line.color);
      return;
    }
    this.message(`<${this.player.name}> ${t}`);
    this.net?.chat(t);
  }

  daylight(): number {
    const angle = ((this.time % DAY_TICKS) / DAY_TICKS) * Math.PI * 2;
    let d = Math.max(0, Math.min(1, Math.sin(angle) * 2.2 + 0.45));
    d *= 1 - this.rain * 0.25 - this.thunder * 0.25;
    return Math.max(0.12, d);
  }

  isNight(): boolean {
    const t = this.time % DAY_TICKS;
    return t > 12542 && t < 23460;
  }

  setScreen(screen: Screen | null): void {
    const was = this.screen;
    if (was && (was.kind === "inventory" || was.kind === "crafting")) this.returnGrid();
    if (this.cursor && (!screen || screen.kind === "pause")) {
      const left = this.player.inventory.add(this.cursor);
      if (left > 0) this.actions.throwStack({ ...this.cursor, count: left });
      this.cursor = null;
    }
    if (screen?.kind === "crafting") this.craftGrid = new Array(9).fill(null);
    else if (screen?.kind === "inventory") this.craftGrid = [null, null, null, null];
    if (was?.kind === "chest" && screen?.kind !== "chest") this.sound("chest_close", was.x + 0.5, was.y + 0.5, was.z + 0.5, 0.5);
    this.screen = screen;
    if (screen) { this.controls.attack = false; this.controls.use = false; this.actions.stopUsing(); }
    this.store.set({ screen, inv: this.store.get().inv + 1 });
  }

  /** Items left in a crafting grid go back to the inventory when it closes (or on the floor if full). */
  private returnGrid(): void {
    for (const s of this.craftGrid) {
      if (!s) continue;
      const left = this.player.inventory.add(s);
      if (left > 0) this.actions.throwStack({ ...s, count: left });
    }
    this.craftGrid = this.craftGrid.map(() => null);
  }

  respawn(): void {
    const p = this.player;
    let spawn = p.spawn;
    if (spawn && this.world.blockAt(Math.floor(spawn.x), Math.floor(spawn.y), Math.floor(spawn.z)) !== B.RED_BED) {
      if (this.world.isLoaded(Math.floor(spawn.x), Math.floor(spawn.z))) {
        this.message("Your home bed was missing or obstructed", "#ffcc55");
        p.spawn = null;
        spawn = null;
      }
    }
    const s = spawn ? { x: spawn.x + 0.5, y: spawn.y + 0.6, z: spawn.z + 0.5 } : this.worldSpawn();
    p.respawn(s.x, s.y, s.z);
    this.needsSurface = !spawn;
    if (this.meta.hardcore) p.setGameMode("spectator");
    this.spawnPlaced = false;
    this.setScreen(null);
  }

  worldSpawn(): { x: number; y: number; z: number } {
    if (!this.meta.spawn) this.meta.spawn = this.generator.findSpawn();
    return { ...this.meta.spawn };
  }

  /** Moves the player to the top of the ground at their spawn column once that chunk has loaded. */
  private placeAtSpawnIfNeeded(): boolean {
    if (this.spawnPlaced) return true;
    const b = this.player.body;
    const x = Math.floor(b.x), z = Math.floor(b.z);
    if (!this.world.isLoaded(x, z)) return false;
    // A fresh world, or a respawn at world spawn, stands the player on the
    // ground once the area exists — the generator's height estimate does not
    // know about trees, and a new player dropped on a forest canopy is stuck
    // in the leaves before they have punched anything.
    if (this.needsSurface || b.y < 1) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!this.world.isLoaded(x + dx * 16, z + dz * 16)) return false;
      const ground = this.groundNear(x, z);
      if (ground) {
        b.x = ground.x; b.z = ground.z; b.y = ground.y;
        if (this.needsSurface) this.meta.spawn = { ...ground };
      } else {
        const y = this.world.topSolid(x, z);
        b.y = (y < 0 ? SEA_LEVEL : y) + 1;
      }
      this.player.prevX = b.x; this.player.prevY = b.y; this.player.prevZ = b.z;
      this.needsSurface = false;
    }
    this.spawnPlaced = true;
    return true;
  }

  /** The nearest column, spiralling out, whose top is ground to stand on: not leaves, a trunk or water. */
  private groundNear(x: number, z: number): { x: number; y: number; z: number } | null {
    for (let r = 0; r <= 16; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = x + dx, cz = z + dz;
          if (!this.world.isLoaded(cx, cz)) continue;
          const y = this.world.topSolid(cx, cz);
          if (y < 0 || y >= WORLD_HEIGHT - 2) continue;
          const top = this.world.blockAt(cx, y, cz);
          if (isLeaves(top) || isLog(top) || isFluid(top) || !block(top).solid) continue;
          return { x: cx + 0.5, y: y + 1, z: cz + 0.5 };
        }
      }
    }
    return null;
  }
  private needsSurface = false;

  // ---- the loop ------------------------------------------------------------------------------

  /**
   * A hidden tab gets no animation frames. Alone that is a pause, but online
   * it would freeze the host's world for every guest (and time a hidden guest
   * out), and a second tab on the same device is always hidden. So while
   * linked, a timer keeps the ticks going — browsers slow it to about once a
   * second, and each call catches up the ticks it missed.
   */
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  /** Re-checked when the tab's visibility or the link changes. */
  readonly syncBackground = (): void => {
    if (document.visibilityState === "hidden" && this.net && this.running) {
      if (!this.backgroundTimer) this.backgroundTimer = setInterval(() => this.background(performance.now()), 50);
    } else if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  };

  private background(now: number): void {
    if (!this.running || !this.net) { this.syncBackground(); return; }
    const dt = Math.min(5000, now - this.lastFrame);
    this.lastFrame = now;
    if (!this.placeAtSpawnIfNeeded()) return;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 100) {
      this.tick();
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps === 100) this.acc = 0;
    this.streamer.update(this.streamCentres(), now);
  }

  private streamCentres(): { x: number; z: number }[] {
    const b = this.player.body;
    const out = [{ x: b.x, z: b.z }];
    // The host keeps the world loaded around every guest: their edits and the mobs near them run here.
    if (this.net?.role === "host") for (const r of this.remote.values()) out.push({ x: r.x, z: r.z });
    return out;
  }

  private frame(now: number): void {
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsTime); this.fpsFrames = 0; this.fpsTime = 0; }

    this.actions.frameInput(dt);

    const loaded = this.placeAtSpawnIfNeeded();
    this.acc += dt * 1000;
    let steps = 0;
    while (this.acc >= TICK_MS && steps < 5) {
      if (loaded) this.tick();
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps === 5) this.acc = 0;
    const alpha = Math.min(1, this.acc / TICK_MS);

    const p = this.player;
    const b = p.body;
    this.streamer.update(this.streamCentres(), now);

    this.actions.updateTarget();
    this.hurtTilt = Math.max(0, this.hurtTilt - dt * 3);

    const ix = p.prevX + (b.x - p.prevX) * alpha, iy = p.prevY + (b.y - p.prevY) * alpha, iz = p.prevZ + (b.z - p.prevZ) * alpha;
    const eye = iy + b.eyeHeight;
    const walk = p.prevWalkDist + (p.walkDist - p.prevWalkDist) * alpha;
    const speed = Math.hypot(b.x - p.prevX, b.z - p.prevZ);
    const bobAmount = this.settings.viewBobbing && b.onGround && !p.flying ? Math.min(1, speed * 5) : 0;
    const eyeBlock = this.world.blockAt(Math.floor(ix), Math.floor(eye), Math.floor(iz));
    const heldId = p.inventory.held?.id ?? null;
    const lightAt = this.world.getLight(Math.floor(ix), Math.floor(eye), Math.floor(iz));
    const [sky, blockLight] = lightAt < 0 ? [1, 0] : [(lightAt >> 4) / 15, (lightAt & 15) / 15];
    const biome = biomeDef(this.world.chunkAt(Math.floor(b.x), Math.floor(b.z))?.biomes[((Math.floor(b.z) & 15) << 4) | (Math.floor(b.x) & 15)] ?? 7);

    const local: RemotePlayerView = {
      id: p.id, name: p.name, x: ix, y: iy, z: iz, yaw: p.yaw, pitch: p.pitch, walk, speed, swing: this.actions.swingProgress(alpha),
      sneaking: p.sneaking, heldItem: heldId, variant: this.settings.skin, hurt: p.hurtTime > 0, dead: p.dead,
    };
    const remote: RemotePlayerView[] = [];
    for (const r of this.remote.values()) {
      const t = Math.min(1, (now - r.receivedAt) / 120);
      remote.push({
        id: r.id, name: r.name, x: r.px + (r.x - r.px) * t, y: r.py + (r.y - r.py) * t, z: r.pz + (r.z - r.pz) * t,
        yaw: r.pyaw + angleDiff(r.pyaw, r.yaw) * t, pitch: r.pitch, walk: r.walk, speed: r.speed, swing: r.swing,
        sneaking: r.sneaking, heldItem: r.held, variant: r.variant, hurt: r.hurt, dead: r.dead || r.gameMode === "spectator",
      });
    }

    const target = this.actions.target?.block ?? null;
    this.renderer.render({
      dt, alpha,
      camera: { x: ix, y: eye, z: iz, yaw: p.yaw, pitch: p.pitch, fov: this.settings.fov * (p.sprinting ? 1.1 : 1) * (this.actions.bowFov()) },
      perspective: this.perspective,
      bob: { walk, amount: bobAmount },
      hurtTilt: this.hurtTilt,
      time: this.time + alpha,
      rain: this.rain,
      thunder: this.thunder,
      lightning: this.lightning,
      snowing: biome.snowy,
      renderDistance: this.settings.renderDistance,
      underwater: eyeBlock === B.WATER,
      inLava: eyeBlock === B.LAVA,
      nightVision: p.hasEffect("night_vision"),
      // Re-iterable, so a screenshot can draw the same frame again.
      entities: { [Symbol.iterator]: () => this.entities.values() },
      localPlayer: local,
      remotePlayers: remote,
      target: target ? { x: target.x, y: target.y, z: target.z } : null,
      crack: this.actions.crackStage(),
      hand: {
        itemId: heldId, swing: this.actions.swingProgress(alpha), equip: this.actions.equipOffset(), walk, bob: bobAmount,
        sky, block: blockLight, eating: this.actions.eatingPhase(), bowPull: this.actions.bowPull(), skinVariant: this.settings.skin,
        hurt: p.hurtTime > 0,
      },
      showHand: !this.hudHidden && !p.dead && p.gameMode !== "spectator",
      clouds: this.settings.clouds,
      wave: this.settings.graphics === "fancy",
    });
    this.lightning = 0;
    this.audio.setListener(ix, eye, iz, p.yaw);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.store.set(this.hudSnapshot());
    }
  }

  private tick(): void {
    this.tickCount++;
    const p = this.player;
    p.beginTick();
    for (const e of this.entities.values()) e.beginTick();
    for (const r of this.remote.values()) if (r.hurt && performance.now() - r.lastSeen > 500) r.hurt = false;

    const b = p.body;
    const inputBlocked = !!this.screen && this.screen.kind !== "chat";
    const c = this.controls;
    const frozen = !this.world.isLoaded(Math.floor(b.x), Math.floor(b.z));
    if (!frozen) {
      p.tick(this.world, {
        forward: inputBlocked ? 0 : c.forward, strafe: inputBlocked ? 0 : c.strafe,
        jump: !inputBlocked && (c.jump || this.actions.autoJumpNow()), sneak: !inputBlocked && c.sneak, sprint: !inputBlocked && c.sprint,
      }, { difficulty: this.meta.difficulty, naturalRegeneration: this.meta.rules.naturalRegeneration, raining: this.rain > 0.5 });
    }
    this.handlePlayerEvents(p.events.splice(0));
    this.actions.tick();

    // Footsteps.
    if (b.onGround && !p.sneaking) {
      this.stepDist += Math.hypot(b.x - p.prevX, b.z - p.prevZ);
      if (this.stepDist > 1.7) {
        this.stepDist = 0;
        const g = groundBlock(this.world, b);
        if (g) this.blockSound(block(g).material, "step", b.x, b.y, b.z, false);
      }
    }
    if (b.inWater && Math.hypot(b.vx, b.vz) > 0.05 && this.tickCount % 12 === 0) this.audio.play("swim", b.x, b.y, b.z, 0.3);

    if (this.simulates) this.simulate();
    else this.guestTick();

    this.net?.tick();

    if (this.role !== "guest" && ++this.saveTimer >= AUTOSAVE_TICKS) {
      this.saveTimer = 0;
      void this.saveNow().catch((e: Error) => this.message(`Autosave failed: ${e.message}`, "#ff6666"));
    }
    if (this.tickCount % 20 === 0) this.audio.tickMusic(1, !this.isNight());
  }

  private handlePlayerEvents(events: PlayerEvent[]): void {
    const p = this.player;
    for (const ev of events) {
      switch (ev.type) {
        case "hurt":
          if (ev.amount > 0) this.sound("hurt", null, 0, 0, 0.8, 0.9 + Math.random() * 0.2);
          break;
        case "death":
          this.message(ev.message, "#ff8888");
          this.net?.chat(`\u0000death:${ev.message}`);
          this.onDeath();
          break;
        case "land":
          if (ev.distance > 1.5 && ev.block > 0) this.blockSound(block(ev.block).material, "step", p.body.x, p.body.y, p.body.z, false);
          if (ev.distance > 3 && p.survivalLike) this.particles("block", p.body.x, p.body.y + 0.1, p.body.z, 8, ev.block, false);
          // Trampled farmland.
          if (ev.distance > 1 && ev.block === B.FARMLAND && p.survivalLike) {
            const x = Math.floor(p.body.x), y = Math.floor(p.body.y - 0.2), z = Math.floor(p.body.z);
            if (Math.random() < ev.distance - 0.5) this.world.setBlock(x, y, z, B.DIRT, 0, "player");
          }
          break;
        case "splash":
          this.sound("splash", p.body.x, p.body.y, p.body.z, 0.6);
          this.particles("splash", p.body.x, p.body.y + 0.5, p.body.z, 12);
          break;
        case "levelup":
          this.sound("levelup", null, 0, 0, 0.8);
          break;
        case "eat":
          this.sound("burp", null, 0, 0, 0.4, 0.9 + Math.random() * 0.2);
          break;
      }
    }
  }

  private onDeath(): void {
    const p = this.player;
    const b = p.body;
    this.actions.stopUsing();
    if (!this.meta.rules.keepInventory) {
      const inv = p.inventory;
      for (const s of [...inv.slots, ...inv.armor, inv.offhand]) {
        if (s) this.dropItem(b.x, b.y + 1, b.z, s, (Math.random() - 0.5) * 0.5, 0.2 + Math.random() * 0.2, (Math.random() - 0.5) * 0.5);
      }
      inv.clear();
      this.spawnXp(b.x, b.y + 1, b.z, p.deathXp());
      p.xpLevel = 0; p.xpPoints = 0;
      if (this.cursor) { this.dropItem(b.x, b.y + 1, b.z, this.cursor); this.cursor = null; }
      for (const s of this.craftGrid) if (s) this.dropItem(b.x, b.y + 1, b.z, s);
      this.craftGrid = this.craftGrid.map(() => null);
    }
    this.bumpInv();
    this.setScreen({ kind: "death" });
  }

  /** The host's (or single player's) share of each tick: the world itself. */
  private simulate(): void {
    const world = this.world;
    world.tick++;
    if (this.meta.rules.doDaylightCycle) this.time++;
    this.weatherTick();

    // Scheduled block updates, budgeted so a lava lake settling cannot stall a frame.
    const due = world.takeDue(2000);
    for (const [x, y, z] of due) this.rules.onTick(x, y, z);
    this.rules.randomTicks(this.playerRefs().map((r) => ({ x: r.x, z: r.z })), 4);
    this.tickFurnaces();

    const ctx = this.ctx;
    for (const e of this.entities.values()) {
      if (!world.isLoaded(Math.floor(e.x), Math.floor(e.z))) continue;
      e.tick(ctx);
    }
    for (const [id, e] of this.entities) if (e.removed) this.entities.delete(id);

    if (this.tickCount % 20 === 0) this.spawnMobs();
    this.sleepTick();
  }

  private guestTick(): void {
    this.time++;
    // Between host snapshots, carry entities along their last velocity.
    for (const e of this.entities.values()) {
      const b = e.body;
      b.x += b.vx; b.y += b.vy * 0.5; b.z += b.vz;
      e.walkDist += Math.hypot(b.vx, b.vz);
    }
  }

  private weatherTick(): void {
    const w = this.meta.weather;
    if (this.meta.rules.doWeatherCycle) {
      if (--w.rainTimer <= 0) {
        const raining = w.rain > 0.5;
        w.rain = raining ? 0 : 1;
        w.rainTimer = raining ? 12000 + Math.floor(Math.random() * 168000) : 12000 + Math.floor(Math.random() * 12000);
      }
      if (--w.thunderTimer <= 0) {
        const thundering = w.thunder > 0.5;
        w.thunder = thundering ? 0 : 1;
        w.thunderTimer = thundering ? 12000 + Math.floor(Math.random() * 168000) : 3600 + Math.floor(Math.random() * 12000);
      }
    }
    const targetRain = w.rain, targetThunder = w.rain > 0.5 ? w.thunder : 0;
    this.rain += Math.sign(targetRain - this.rain) * Math.min(0.01, Math.abs(targetRain - this.rain));
    this.thunder += Math.sign(targetThunder - this.thunder) * Math.min(0.01, Math.abs(targetThunder - this.thunder));
    this.audio.setRain(this.rain);
    if (this.thunder > 0.9 && Math.random() < 1 / 400) {
      this.lightning = 1;
      const delay = 200 + Math.random() * 1500;
      setTimeout(() => this.sound("thunder", this.player.body.x + (Math.random() - 0.5) * 60, this.player.body.y + 20, this.player.body.z + (Math.random() - 0.5) * 60, 1, 0.8), delay);
      this.net?.effect("explosion", ["lightning"]);
    }
  }

  private spawnMobs(): void {
    const refs = this.playerRefs();
    if (!refs.length || !this.meta.rules.doMobSpawning) return;
    let hostile = 0, passive = 0;
    for (const e of this.entities.values()) {
      if (!(e instanceof Mob)) continue;
      if (e.spec.hostile) {
        hostile++;
        // Despawn monsters nobody is near; peaceful removes them all.
        const nearest = Math.min(...refs.map((r) => Math.hypot(r.x - e.x, r.z - e.z)));
        if (this.meta.difficulty === 0 || nearest > 128 || (nearest > 32 && Math.random() < 1 / 40)) e.removed = true;
      } else passive++;
    }
    const origin = refs[Math.floor(Math.random() * refs.length)];
    if (this.meta.difficulty > 0 && hostile < MAX_HOSTILE * refs.length) {
      for (let attempt = 0; attempt < 3; attempt++) this.trySpawn(origin, true);
    }
    if (passive < MAX_PASSIVE * refs.length && (this.tickCount % 400 === 0 || this.tickCount < 200)) {
      for (let attempt = 0; attempt < 4; attempt++) this.trySpawn(origin, false);
    }
  }

  private trySpawn(origin: PlayerRef, hostile: boolean): void {
    const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 24;
    const x = Math.floor(origin.x + Math.cos(a) * r), z = Math.floor(origin.z + Math.sin(a) * r);
    const chunk = this.world.chunkAt(x, z);
    if (!chunk) return;
    const top = this.world.topSolid(x, z);
    if (top < 1) return;
    const daylight = this.daylight();
    let y: number;
    if (hostile) {
      // Anywhere dark: the surface at night, or a cave by day.
      y = Math.random() < 0.5 ? top + 1 : 1 + Math.floor(Math.random() * top);
    } else y = top + 1;
    const below = this.world.blockAt(x, y - 1, z);
    if (!block(below).opaque || block(this.world.blockAt(x, y, z)).solid || block(this.world.blockAt(x, y + 1, z)).solid) return;
    if (isFluid(this.world.blockAt(x, y, z))) return;
    const l = this.world.getLight(x, y, z);
    if (l < 0) return;
    const sky = (l >> 4) * daylight, blockLight = l & 15;
    const biome = biomeDef(chunk.biomes[((z & 15) << 4) | (x & 15)]);
    if (hostile) {
      if (blockLight > 0 || sky >= 8) return;
      const kinds: MobKind[] = ["zombie", "skeleton", "creeper", "spider"];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const group = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < group; i++) this.spawn(new Mob(kind, x + 0.5 + (i % 2), y, z + 0.5 + Math.floor(i / 2)));
    } else {
      if (below !== B.GRASS || (l >> 4) < 9 || !biome.passive.length) return;
      const kind = biome.passive[Math.floor(Math.random() * biome.passive.length)] as MobKind;
      if (!MOB_KINDS.includes(kind)) return;
      const group = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < group; i++) {
        const m = new Mob(kind, x + 0.5 + (Math.random() - 0.5) * 3, y, z + 0.5 + (Math.random() - 0.5) * 3);
        if (Math.random() < 0.1) m.setBaby();
        this.spawn(m);
      }
    }
  }

  private sleepTick(): void {
    const sleepers = (this.player.sleeping ? 1 : 0) + [...this.remote.values()].filter((r) => r.sleeping).length;
    const total = 1 + this.remote.size;
    if (sleepers > 0 && sleepers === total) {
      this.sleepCounter++;
      if (this.sleepCounter >= 100) {
        this.time = Math.ceil(this.time / DAY_TICKS) * DAY_TICKS;
        this.meta.weather.rain = 0; this.meta.weather.thunder = 0;
        this.rain = 0; this.thunder = 0;
        this.actions.wakeUp();
        this.sleepCounter = 0;
      }
    } else this.sleepCounter = 0;
  }

  // ---- saving ------------------------------------------------------------------------------

  async saveNow(): Promise<void> {
    if (this.role === "guest" || this.savingNow) return;
    this.savingNow = true;
    this.store.set({ saving: true });
    try {
      const chunks: ChunkData[] = [];
      for (const id of this.dirtySave) {
        const c = this.world.chunks.get(id);
        if (c) chunks.push(this.chunkData(c));
      }
      this.dirtySave.clear();
      await this.saves.putChunks(this.meta.id, chunks);
      const meta = this.meta;
      meta.time = this.time;
      meta.lastPlayed = Date.now();
      meta.playTime = this.playTimeBase + (performance.now() - this.startedAt) / 1000;
      meta.player = this.player.toJSON();
      meta.entities = [...this.entities.values()]
        .filter((e) => (e instanceof Mob && e.persistent && !e.dying) || e instanceof ItemEntity)
        .slice(0, 600)
        .map((e) => e.snapshot());
      await this.saves.putWorld(meta);
    } finally {
      this.savingNow = false;
      this.store.set({ saving: false });
    }
  }

  async thumbnail(): Promise<void> {
    try {
      const src = this.renderer.screenshot("image/jpeg", 0.8);
      const img = new Image();
      await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = src; });
      const c = document.createElement("canvas");
      c.width = 160; c.height = 90;
      c.getContext("2d")!.drawImage(img, 0, 0, 160, 90);
      this.meta.thumbnail = c.toDataURL("image/jpeg", 0.7);
    } catch {
      /* a missing thumbnail is cosmetic */
    }
  }

  // ---- HUD ------------------------------------------------------------------------------------

  private hudSnapshot(): Hud {
    const p = this.player;
    const inv = p.inventory;
    if (inv.selected !== this.lastSelected || (inv.held?.id ?? null) !== this.lastHeldId) {
      this.lastSelected = inv.selected;
      this.lastHeldId = inv.held?.id ?? null;
      this.heldNameAt = performance.now();
    }
    const b = p.body;
    const ready = this.streamer.readiness(Math.floor(b.x) >> 4, Math.floor(b.z) >> 4, Math.min(2, this.settings.renderDistance), (id) => this.renderer.chunks.has(id));
    const loading = ready.done < ready.total || !this.spawnPlaced
      ? { done: ready.done, total: ready.total, message: this.role === "guest" ? "Joining world" : "Building terrain" }
      : null;
    const prev = this.store?.get();
    return {
      health: p.health,
      food: p.food,
      air: p.air,
      armor: p.armor,
      xpLevel: p.xpLevel,
      xpProgress: p.xpProgress,
      absorption: p.hasEffect("absorption") ? 4 : 0,
      hotbar: inv.slots.slice(0, 9),
      selected: inv.selected,
      heldName: inv.held ? itemDef(inv.held.id)?.displayName ?? "" : "",
      heldNameAt: this.heldNameAt,
      gameMode: p.gameMode,
      hardcore: this.meta.hardcore,
      screen: this.screen,
      chat: this.chatLines.slice(-50),
      dead: p.dead,
      deathMessage: p.deathMessage,
      loading: loading && performance.now() - this.startedAt < 60000 ? loading : null,
      attackCharge: p.attackStrength(),
      breaking: this.actions?.breakProgress() ?? 0,
      hurtAt: this.lastHurtAt,
      sleeping: p.sleeping ? Math.min(1, p.sleepTicks / 100) : 0,
      hudHidden: this.hudHidden,
      debug: this.debug ? this.debugLines() : null,
      coords: this.settings.showCoordinates ? `${Math.floor(b.x)}, ${Math.floor(b.y)}, ${Math.floor(b.z)}` : null,
      fps: this.fps,
      inv: prev?.inv ?? 0,
      title: this.title && performance.now() - this.title.at < 4000 ? this.title : null,
      actionbar: this.actionbar && performance.now() - this.actionbar.at < 2500 ? this.actionbar : null,
      net: prev?.net ?? null,
      saveProblem: this.saves.problem,
      saving: prev?.saving ?? false,
      onFire: p.fireTicks > 0,
      underwater: p.body.eyesInWater,
      perspective: this.perspective,
    };
  }

  private debugLines(): string[] {
    const p = this.player, b = p.body;
    const x = Math.floor(b.x), y = Math.floor(b.y), z = Math.floor(b.z);
    const chunk = this.world.chunkAt(x, z);
    const biome = chunk ? biomeDef(chunk.biomes[((z & 15) << 4) | (x & 15)]).name : "?";
    const l = this.world.getLight(x, y, z);
    const facing = ["south", "west", "north", "east"][Math.round(((-p.yaw / (Math.PI / 2)) % 4 + 4 + 2) % 4) % 4];
    const stats = this.renderer.stats();
    const t = this.actions.target?.block;
    return [
      `BlockCraft — ${this.fps} fps · ${this.role}${this.net ? ` · ${this.net.kind} ${this.net.room}` : ""}`,
      `XYZ: ${b.x.toFixed(3)} / ${b.y.toFixed(3)} / ${b.z.toFixed(3)}`,
      `Block: ${x} ${y} ${z}   Chunk: ${x >> 4} ${z >> 4}`,
      `Facing: ${facing} (${(((p.yaw * 180) / Math.PI) % 360).toFixed(1)} / ${((p.pitch * 180) / Math.PI).toFixed(1)})`,
      `Biome: ${biome}`,
      `Light: ${l < 0 ? "?" : `${l >> 4} sky, ${l & 15} block`}   Day ${Math.floor(this.time / DAY_TICKS)}, time ${this.time % DAY_TICKS}`,
      `Chunks: ${this.world.chunks.size} loaded, ${stats.chunks} drawn, ${this.streamer.busy} in flight (${this.pool.mode})`,
      `Draw: ${stats.calls} calls, ${(stats.triangles / 1000).toFixed(0)}k tris, ${(stats.quads / 1000).toFixed(0)}k quads`,
      `Entities: ${this.entities.size}   Players: ${1 + this.remote.size}`,
      `Seed: ${this.meta.seed}   Type: ${this.meta.type}`,
      ...(t ? [`Target: ${block(this.world.blockAt(t.x, t.y, t.z)).name} @ ${t.x} ${t.y} ${t.z} meta ${this.world.getMeta(t.x, t.y, t.z)}`] : []),
      ...(this.streamer.lastError ? [`Last chunk error: ${this.streamer.lastError}`] : []),
    ];
  }

  setNetStatus(net: Hud["net"]): void {
    this.store.set({ net });
  }

  /** Where the world's top is near the player (for /tp and respawns). */
  surfaceAt(x: number, z: number): number {
    const y = this.world.topSolid(Math.floor(x), Math.floor(z));
    return y < 0 ? WORLD_HEIGHT : y + 1;
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

