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
import { B, block, containerSize, FACE_DIRS, isFluid, isLeaves, isLog, type Material } from "../engine/blocks";
import { Redstone, type Body as RedstoneBody, type RedstoneContext } from "../engine/redstone";
import { chunkId, entityStacks, newBrewing, newChest, newFurnace, type BlockEntity, type BrewingEntity, type Chunk, type FurnaceEntity } from "../engine/chunk";
import { DAY_TICKS, SEA_LEVEL, TICK_MS, WORLD_HEIGHT } from "../engine/constants";
import { BlockRules, tickDelay } from "../engine/blockRules";
import { COOK_TICKS, fuelTicks, smeltResult } from "../engine/crafting";
import {
  AreaCloud, bumpEntityIds, EndCrystal, FallingBlock, ItemEntity, PrimedTnt, Projectile, XpOrb, xpOrbValues,
  type DamageSource, type Entity, type EntityContext, type EntitySnapshot, type PlayerRef, type ProjectileKind,
} from "../engine/entities";
import { blastImpact, explosionBlocks, exposure } from "../engine/explosion";
import { itemDef, itemId, maxStack, resolveDrops, type ItemStack, type StatusEffect } from "../engine/items";
import { isSlimeChunk, Mob, MOB_KINDS, type MobKind } from "../engine/mobs";
import { groundBlock } from "../engine/physics";
import { Player, type PlayerEvent } from "../engine/player";
import { Generator, type ChunkGenerator } from "../engine/worldgen";
import { createGenerator } from "../engine/generators";
import { DIMENSION_INFO, isDimension, type Dimension } from "../engine/dimension";
import { buildAtlas, type AtlasData } from "../engine/atlas";
import { WorkerPool } from "../engine/workerPool";
import { World, type BlockChange } from "../engine/world";
import { BiomeId, biomeDef } from "../engine/biomes";
import { newlyEarned, type AdvancementEvent } from "../engine/advancements";
import { GameAudio } from "../audio";
import { WorldRenderer, type RemotePlayerView } from "../render/renderer";
import { bottleBits, tickBrewing } from "../engine/brewing";
import { levelOf } from "../engine/enchanting";
import { potionOfItem, splashSeconds } from "../engine/potions";
import { Boat, Minecart, Vehicle, vehicleFromSnapshot } from "../engine/vehicles";
import { golemParts, villageLoot } from "../engine/villages";
import { fortressesTouching, fortressLoot, inFortress, NETHER_LAVA_LEVEL, SPAWNER_MOBS } from "../engine/nether";
import { planPortal, type PortalAxis } from "../engine/portal";
import { findEndPortal, inStronghold, nearestStronghold, strongholdLoot } from "../engine/stronghold";
import { buildGateway, cityLoot, END_SPAWN, EndGenerator, endCitiesTouching, GATEWAY_COUNT, gatewayPosition } from "../engine/end";
import { EndFight } from "./endFight";
import { FRAME_EYE } from "../engine/blocks";
import { hash4 } from "../engine/rng";
import { Actions } from "./actions";
import type { ThrowExtra } from "../net/session";
import { runCommand } from "./commands";
import { SaveStore, type ChunkData, type WorldMeta } from "./save";
import { effectiveControls, saveSettings, type Settings } from "./settings";
import { Store } from "./store";
import { Streamer } from "./streamer";
import { emptyControls, type ChatLine, type Controls, type Hud, type Screen } from "./types";
import { sanitizeStack, type Slot } from "../engine/inventory";

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
  attack(entityId: number, damage: number, fromX: number, fromZ: number, knockback?: number, fire?: number, looting?: number): void;
  interact(entityId: number, item: string | null): void;
  drops(x: number, y: number, z: number, stacks: ItemStack[], xp: number): void;
  throwItem(kind: ProjectileKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, extra?: ThrowExtra): void;
  primeTnt(x: number, y: number, z: number, fuse: number): void;
  blockEntity(x: number, y: number, z: number, e: BlockEntity | null): void;
  sleeping(on: boolean): void;
  chunkLoaded?(cx: number, cz: number, fromSave: boolean): void;
  // host → guests
  hurtRemote(id: string, amount: number, source: DamageSource, fx: number, fz: number, kb: number, attacker?: number): void;
  effectRemote?(id: string, effect: StatusEffect, seconds: number, amp: number): void;
  giveRemote(id: string, stack: ItemStack): void;
  xpRemote(id: string, amount: number): void;
  effect(kind: "sound" | "particles" | "explosion", data: unknown[]): void;
  /** A guest earned an advancement through something only the host simulates (a kill, a night slept through). */
  advanceRemote?(id: string, event: AdvancementEvent): void;
  /** A piston shoved a guest: move them on their own screen, which owns their position. */
  pushRemote?(id: string, dx: number, dy: number, dz: number): void;
  /** Guest → host: climb into, or out of, a vehicle; where the vehicle a guest drives went; put one down. */
  mount?(entityId: number, on: boolean): void;
  /** Guest → host: a trade was made with a villager (the host owns its experience and stock). */
  trade?(entityId: number, offer: number): void;
  vehiclePose?(v: Vehicle): void;
  placeVehicle?(kind: string, x: number, y: number, z: number, yaw: number, wood: number): void;
  /** Host: the party moves to another dimension, arriving around x, y, z. */
  dimensionChanged?(dim: Dimension, x: number, y: number, z: number): void;
  /** Host: where it actually landed there (by the portal it came out of), for guests to land beside. */
  partyLanded?(x: number, y: number, z: number): void;
  /** Host → guest: carry this player somewhere (their pearl landed, or went through a gateway). */
  teleportRemote?(id: string, to: Arrival): void;
  /** Guest → host: set an end crystal on the block at x, y, z. */
  placeCrystal?(x: number, y: number, z: number): void;
  /** Guest: settles once the host has said which chunks of the new dimension it changed. */
  readonly keysReady?: Promise<void> | null;
  /** Guest: the host's connection id. */
  readonly hostConnection?: string | null;
  close(): void;
}

/** Where a player lands after changing dimension. */
export type Arrival =
  /** Through a portal: into the recorded one at x,y,z when `known`, else a new one built near there. */
  | { kind: "portal"; x: number; y: number; z: number; axis: PortalAxis; known: boolean }
  /** Respawning: at the world spawn or a bed, on the ground. */
  | { kind: "spawn"; x: number; y: number; z: number }
  /** Exactly here (a guest following the host); `wait` until the host has said where it landed. */
  | { kind: "exact"; x: number; y: number; z: number; wait?: number }
  /** Into the End: onto the obsidian platform, built fresh (and cleared) each time, as in the original. */
  | { kind: "platform"; x: number; y: number; z: number }
  /** Through a gateway: on top of gateway `index`'s cage by the main island (`inner`), or on the ground under its far end. */
  | { kind: "gateway"; x: number; y: number; z: number; index: number; inner: boolean };

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
  /** Drank invisibility: drawn as nothing. */
  invisible: boolean;
  /** Seated in a boat or a cart. */
  riding: boolean;
  /** Wearing gold, which piglins respect. */
  goldArmor: boolean;
  /** On elytra, drawn lying along the flight. */
  gliding: boolean;
  /** A carved pumpkin on the head, which hides them from endermen's stares. */
  pumpkin: boolean;
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
  /** The dimension loaded now: the one the player (online, the host) is in. */
  dimension: Dimension;
  // The world and everything bound to it are rebuilt when the player changes dimension.
  world!: World;
  generator!: ChunkGenerator;
  pool!: WorkerPool;
  readonly renderer: WorldRenderer;
  readonly audio = new GameAudio();
  streamer!: Streamer;
  rules!: BlockRules;
  redstone!: Redstone;
  private atlas: AtlasData;
  private worldUnsubs: (() => void)[] = [];
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
  /** The name typed into an open anvil, or null when untouched. */
  anvilName: string | null = null;
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
  /** Changed chunks on their way to the save, by dimension and chunk id, so reading one back never finds the older copy. */
  private unloaded = new Map<string, ChunkData>();
  private pendingKey(id: number, dim: Dimension = this.dimension): string {
    return `${dim}|${id}`;
  }
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
  readonly endFight = new EndFight(this);

  constructor(opts: GameOptions) {
    this.meta = opts.meta;
    this.role = opts.role;
    this.settings = opts.settings;
    this.saves = opts.saves;
    this.time = opts.meta.time;
    this.rain = opts.meta.weather.rain;
    this.thunder = opts.meta.weather.thunder;
    this.playTimeBase = opts.meta.playTime;
    this.dimension = isDimension(opts.meta.dimension) ? opts.meta.dimension : "overworld";
    this.atlas = buildAtlas();
    this.ctx = this.makeContext();
    this.buildDimension();
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
    this.applySettings(opts.settings);

    for (const s of opts.meta.entities ?? []) this.restoreEntity(s);

    this.store = new Store<Hud>(this.hudSnapshot());
    this.actions = new Actions(this);

    if (this.saves.problem) this.message(this.saves.problem, "#ffcc55");
  }

  /**
   * Builds the world for `this.dimension` and everything bound to it: its
   * generator and workers, block rules, redstone and the chunk streamer. The
   * renderer, audio, player and network link carry across.
   */
  private buildDimension(): void {
    const dim = this.dimension;
    const info = DIMENSION_INFO[dim];
    const world = new World();
    world.simulates = this.role !== "guest";
    this.world = world;
    this.generator = createGenerator({ seed: this.meta.seed, type: this.meta.type, dimension: dim });
    this.pool = new WorkerPool({ kind: "init", settings: { seed: this.meta.seed, type: this.meta.type, dimension: dim }, layers: this.atlas.layers });
    this.rules = new BlockRules(world, {
      dropItems: (x, y, z, stacks) => { for (const s of stacks) this.dropItem(x, y, z, s); },
      spawnFalling: (x, y, z, id, meta) => this.spawn(new FallingBlock(x, y, z, id, meta)),
      sound: (name, x, y, z, v, p) => this.sound(name, x, y, z, v, p),
      isRaining: () => this.rain > 0.5 && info.hasSky,
      random: Math.random,
      igniteTnt: (x, y, z) => { this.spawn(new PrimedTnt(x + 0.5, y, z + 0.5, 80)); this.sound("fuse", x + 0.5, y + 0.5, z + 0.5); },
      portalLit: (x, y, z, axis) => this.recordPortal(this.dimension, x, y, z, axis),
      fireSpreads: () => this.meta.rules.doFireTick !== false,
    }, { lavaFast: info.lavaFast, portals: dim !== "end" });
    this.redstone = new Redstone(world, this.redstoneContext());
    const streamer = new Streamer(
      world, this.pool,
      { load: (cx, cz) => this.loadChunk(cx, cz), unload: (c) => this.unloadChunk(c) },
      { setChunk: (id, cx, cz, mesh) => this.renderer.setChunk(id, cx, cz, mesh), removeChunk: (id) => this.renderer.removeChunk(id) },
      this.settings.renderDistance,
      (chunk, fromSave) => {
        // A chunk the old dimension asked for, arriving after the player left it.
        if (this.world !== world) return;
        this.net?.chunkLoaded?.(chunk.cx, chunk.cz, fromSave);
        if (this.simulates) this.redstone.onChunkLoaded(chunk);
        if (this.simulates && !fromSave) this.settleStructures(chunk.cx, chunk.cz);
      },
    );
    streamer.fancyLeaves = this.settings.graphics === "fancy";
    streamer.smoothLighting = this.settings.smoothLighting;
    this.streamer = streamer;
    for (const u of this.worldUnsubs.splice(0)) u();
    this.worldUnsubs.push(world.onChange((c) => this.redstone.onChange(c)));
    this.worldUnsubs.push(world.onChange((c) => this.onBlockChange(c)));
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
    for (const u of this.worldUnsubs.splice(0)) u();
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
    const pending = this.unloaded.get(this.pendingKey(id));
    if (pending) return { ...pending, blocks: pending.blocks.slice(), meta: pending.meta.slice() };
    if (this.role === "guest") {
      // Just after the party changed dimension the host is still reading which chunks it changed there.
      if (this.net?.keysReady) await this.net.keysReady;
      if (this.net && this.net.isModified(cx, cz)) return this.net.requestChunk(cx, cz);
      return null;
    }
    return this.saves.getChunk(this.meta.id, cx, cz, this.dimension);
  }

  private unloadChunk(c: Chunk): void {
    if (this.role === "guest") return;
    this.persistChunks([this.chunkData(c)], this.dimension);
    this.dirtySave.delete(c.id);
  }

  /**
   * Writes chunks of a dimension, keeping each in memory until the save lands
   * so walking straight back never reads the older copy from disk.
   */
  private persistChunks(list: ChunkData[], dim: Dimension): void {
    if (!list.length) return;
    const keys = list.map((d) => this.pendingKey(chunkId(d.cx, d.cz), dim));
    list.forEach((d, i) => this.unloaded.set(keys[i], d));
    void this.saves.putChunks(this.meta.id, list, dim)
      .then(() => list.forEach((d, i) => { if (this.unloaded.get(keys[i]) === d) this.unloaded.delete(keys[i]); }))
      .catch((e: Error) => this.message(`Could not save part of the world: ${e.message}`, "#ff6666"));
  }

  chunkData(c: Chunk): ChunkData {
    return { cx: c.cx, cz: c.cz, blocks: c.blocks.slice(), meta: c.meta.slice(), entities: [...c.entities.entries()].map(([i, e]) => [i, structuredClone(e)]) };
  }

  /** Keys ("cx,cz") of a dimension's chunks still on their way to the save: changed, but not yet listed by it. */
  pendingChunkKeys(dim: Dimension): string[] {
    const out: string[] = [];
    for (const [key, d] of this.unloaded) if (key.startsWith(`${dim}|`)) out.push(`${d.cx},${d.cz}`);
    return out;
  }

  /** Current contents of a chunk if this game holds it (loaded or awaiting save) — the host answers guests from this. */
  async chunkForGuest(cx: number, cz: number): Promise<ChunkData | null> {
    const c = this.world.chunk(cx, cz);
    if (c) return this.chunkData(c);
    const pending = this.unloaded.get(this.pendingKey(chunkId(cx, cz)));
    if (pending) return pending;
    return this.saves.getChunk(this.meta.id, cx, cz, this.dimension);
  }

  // ---- dimensions ---------------------------------------------------------------------------

  /** Where the player lands once the destination's chunks are in. */
  private arrival: Arrival | null = null;
  /** Ticks stood in a portal. */
  portalTimer = 0;
  /**
   * Set on arriving in (or being refused) a portal: it cannot fire again until
   * the player steps out. Set from the start too — a world saved while standing
   * in a portal would otherwise send the player through the moment it loads.
   */
  private portalLock = true;
  private loadingSince = performance.now();

  /** Notes a lit portal so a trip from the other side comes out of it rather than building another. */
  recordPortal(dim: Dimension, x: number, y: number, z: number, axis: PortalAxis): void {
    const all = (this.meta.portals ??= {});
    const list = (all[dim] ??= []);
    if (!list.some(([px, py, pz]) => Math.abs(px - x) <= 1 && Math.abs(py - y) <= 2 && Math.abs(pz - z) <= 1)) list.push([x, y, z, axis]);
    if (list.length > 200) list.shift();
  }

  /** Mobs, items and vehicles worth keeping when their dimension goes out of memory. */
  private persistentEntities(): EntitySnapshot[] {
    return [...this.entities.values()]
      // A dragon keeps even its death throes: reloading mid-fall finishes the fall rather than losing the reward.
      .filter((e) => (e instanceof Mob && e.persistent && (!e.dying || e.kind === "ender_dragon")) || e instanceof ItemEntity || e instanceof Vehicle || e instanceof EndCrystal)
      .slice(0, 600)
      .map((e) => e.snapshot());
  }

  /**
   * Moves the player — online, the whole party — to another dimension: the
   * one being left is saved (its changed chunks and its entities), the new
   * one is built, and the player lands at `arrival` once its chunks are in.
   */
  changeDimension(to: Dimension, arrival: Arrival): void {
    if (to === this.dimension) return;
    const from = this.dimension;
    this.dismount();
    this.actions.stopUsing();
    if (this.screen && this.screen.kind !== "death") this.setScreen(null);
    if (this.simulates) {
      const changed: ChunkData[] = [];
      for (const c of this.world.loadedChunks()) if (c.modified) changed.push(this.chunkData(c));
      this.persistChunks(changed, from);
      const others = (this.meta.otherEntities ??= {});
      others[from] = this.persistentEntities();
      this.entities.clear();
      for (const snap of others[to] ?? []) this.restoreEntity(snap);
      delete others[to];
    } else this.entities.clear();
    this.dirtySave.clear();
    this.golemChecks = [];
    this.spawners.clear();
    this.streamer.close();
    this.pool.dispose();
    this.dimension = to;
    this.meta.dimension = to;
    this.buildDimension();
    this.renderer.setWorld(this.world);
    const p = this.player, b = p.body;
    b.x = arrival.x; b.y = arrival.y; b.z = arrival.z;
    b.vx = b.vy = b.vz = 0;
    b.fallDistance = 0;
    p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
    this.arrival = arrival;
    this.spawnPlaced = false;
    this.needsSurface = false;
    this.loadingSince = performance.now();
    this.portalTimer = 0;
    this.portalLock = true;
    this.net?.dimensionChanged?.(to, arrival.x, arrival.y, arrival.z);
    this.advance({ kind: "dimension", dimension: to });
  }

  /** Guest: the host landed here after a change of dimension; come in beside it. */
  partyPosition(x: number, y: number, z: number): void {
    if (this.arrival?.kind === "exact") {
      this.arrival = { kind: "exact", x, y, z };
      return;
    }
    const p = this.player, b = p.body;
    b.x = x + 1; b.y = y; b.z = z;
    b.vx = b.vy = b.vz = 0;
    p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
  }

  /** The portal timer ran out: through to the other side, linked to a portal already there if one is near. */
  private portalTravel(): void {
    const b = this.player.body;
    const to: Dimension = this.dimension === "nether" ? "overworld" : "nether";
    const scale = DIMENSION_INFO[this.dimension].scale / DIMENSION_INFO[to].scale;
    const tx = b.x * scale, tz = b.z * scale;
    const here = this.world.blockAt(Math.floor(b.x), Math.floor(b.y + 0.5), Math.floor(b.z));
    const axis = (here === B.NETHER_PORTAL ? this.world.getMeta(Math.floor(b.x), Math.floor(b.y + 0.5), Math.floor(b.z)) & 1 : 0) as PortalAxis;
    // The original's link distances: 128 blocks out in the overworld, 16 in the Nether.
    const radius = to === "nether" ? 16 : 128;
    let best: [number, number, number, number] | null = null, bestD = Infinity;
    for (const q of this.meta.portals?.[to] ?? []) {
      const d = Math.max(Math.abs(q[0] - tx), Math.abs(q[2] - tz));
      if (d <= radius && d < bestD) { best = q; bestD = d; }
    }
    const y = to === "nether" ? Math.max(NETHER_LAVA_LEVEL + 3, Math.min(110, b.y)) : Math.max(SEA_LEVEL, b.y);
    this.changeDimension(to, best
      ? { kind: "portal", x: best[0], y: best[1], z: best[2], axis: best[3] as PortalAxis, known: true }
      : { kind: "portal", x: Math.floor(tx), y: Math.floor(y), z: Math.floor(tz), axis, known: false });
  }

  /**
   * Portals: a Nether portal takes four seconds stood in it (at once in
   * creative); an End portal takes the player the moment they drop into it,
   * as in the original. Gateways are checked here too.
   */
  private tickPortal(): void {
    const p = this.player, b = p.body;
    const fx = Math.floor(b.x), fz = Math.floor(b.z);
    const at = (dy: number) => this.world.blockAt(fx, Math.floor(b.y + dy), fz);
    const endPortal = at(0.05) === B.END_PORTAL || at(0.6) === B.END_PORTAL;
    const netherPortal = at(0.2) === B.NETHER_PORTAL || at(1.2) === B.NETHER_PORTAL;
    const inside = endPortal || netherPortal;
    if (!inside || p.dead || p.riding !== null) {
      this.portalLock = this.portalLock && inside;
      this.portalTimer = 0;
      this.tickGateway();
      return;
    }
    if (this.portalLock) return;
    if (endPortal) {
      this.portalLock = true;
      if (this.role === "guest") {
        this.showActionbar("Online, portals take the party when the host steps through");
        return;
      }
      this.sound("portal_travel", null, 0, 0, 0.6);
      if (this.dimension === "end") this.leaveEnd();
      else this.changeDimension("end", { kind: "platform", ...END_SPAWN });
      return;
    }
    if (this.portalTimer === 0) this.sound("portal_trigger", b.x, b.y + 1, b.z, 0.6);
    this.portalTimer++;
    if (this.portalTimer < (p.gameMode === "creative" ? 1 : 80)) return;
    this.portalTimer = 0;
    this.portalLock = true;
    if (this.role === "guest") {
      this.showActionbar("Online, portals take the party when the host steps through");
      return;
    }
    this.sound("portal_travel", null, 0, 0, 0.6);
    this.portalTravel();
  }

  /** Out of the End through its exit portal: home to the player's bed, or the world spawn. */
  private leaveEnd(): void {
    const bed = this.player.spawn;
    const target = bed ? { x: bed.x + 0.5, y: bed.y + 0.6, z: bed.z + 0.5 } : this.worldSpawn();
    this.changeDimension("overworld", bed ? { kind: "exact", ...target } : { kind: "spawn", ...target });
  }

  private gatewayCooldown = 0;

  /** Touching a gateway (it is caged top and bottom, so this means reaching in from the side) flings the player through. */
  private tickGateway(): void {
    if (this.dimension !== "end") return;
    if (this.gatewayCooldown > 0) { this.gatewayCooldown--; return; }
    const p = this.player, b = p.body;
    if (p.dead || p.riding !== null || this.arrival) return;
    const reach = b.width / 2 + 0.3;
    for (let y = Math.floor(b.y - 0.3); y <= Math.floor(b.y + b.height + 0.3); y++) {
      for (let z = Math.floor(b.z - reach); z <= Math.floor(b.z + reach); z++) {
        for (let x = Math.floor(b.x - reach); x <= Math.floor(b.x + reach); x++) {
          if (this.world.blockAt(x, y, z) !== B.END_GATEWAY) continue;
          const exit = this.gatewayExit(x, z);
          if (!exit) return;
          this.gatewayCooldown = 60;
          this.sound("portal_travel", null, 0, 0, 0.5);
          this.arriveAt(exit);
          this.advance({ kind: "gateway" });
          return;
        }
      }
    }
  }

  /**
   * Where a gateway at x, z leads: from one by the main island, to the ground
   * under its far end out on the islands; from a far end, onto the top of its
   * partner by the main island.
   */
  gatewayExit(x: number, z: number): Arrival | null {
    const g = this.generator;
    if (!(g instanceof EndGenerator)) return null;
    let best = 0, bestD = Infinity;
    const inner = Math.hypot(x, z) < 400;
    for (let i = 0; i < GATEWAY_COUNT; i++) {
      const [px, , pz] = inner ? gatewayPosition(i) : g.gatewayExit(i).gateway;
      const d = Math.hypot(px - x, pz - z);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (inner) {
      const [lx, ly, lz] = g.gatewayExit(best).land;
      return { kind: "gateway", x: lx + 0.5, y: ly, z: lz + 0.5, index: best, inner: false };
    }
    const [px, py, pz] = gatewayPosition(best);
    return { kind: "gateway", x: px + 0.5, y: py + 3, z: pz + 0.5, index: best, inner: true };
  }

  /** Sends this player somewhere that may not be loaded yet: they hold there until it is, then land. */
  arriveAt(a: Arrival): void {
    const p = this.player, b = p.body;
    b.x = a.x; b.y = a.y; b.z = a.z;
    b.vx = b.vy = b.vz = 0;
    b.fallDistance = 0;
    p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
    p.gliding = false;
    this.arrival = a;
    this.spawnPlaced = false;
  }

  /** Moves this player at once, to a spot already loaded (a pearl's landing, a chorus fruit's jump), lifted clear of any wall. */
  teleportLocal(x: number, y: number, z: number): void {
    const p = this.player, b = p.body, w = this.world;
    let ty = y;
    for (let i = 0; i < 3 && (block(w.blockAt(Math.floor(x), Math.floor(ty), Math.floor(z))).solid || block(w.blockAt(Math.floor(x), Math.floor(ty + 1), Math.floor(z))).solid); i++) ty = Math.floor(ty) + 1;
    b.x = x; b.y = ty; b.z = z;
    b.vx = b.vy = b.vz = 0;
    b.fallDistance = 0;
    p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
  }

  /** An ender pearl came down: its thrower goes there (taking five points of fall), or, if it struck a gateway, through it. */
  private pearlLanded(id: string, x: number, y: number, z: number, gateway: [number, number, number] | null): void {
    const exit = gateway ? this.gatewayExit(gateway[0], gateway[2]) : null;
    if (id === this.player.id) {
      if (this.player.dead) return;
      if (exit) { this.arriveAt(exit); this.advance({ kind: "gateway" }); }
      else { this.teleportLocal(x, y, z); this.hurtLocal(5, "fall"); }
    } else {
      if (!this.remote.has(id)) return;
      this.net?.teleportRemote?.(id, exit ?? { kind: "exact", x, y, z });
      if (!exit) this.net?.hurtRemote(id, 5, "fall", x, z, 0);
      else this.net?.advanceRemote?.(id, { kind: "gateway" });
    }
    this.sound("enderman_teleport", x, y, z, 0.8);
  }

  /** A chorus fruit eaten: up to sixteen tries at a spot within eight blocks with a floor and room to stand. */
  private chorusTeleport(): void {
    const p = this.player, b = p.body, w = this.world;
    for (let i = 0; i < 16; i++) {
      const x = Math.floor(b.x + (Math.random() - 0.5) * 16), z = Math.floor(b.z + (Math.random() - 0.5) * 16);
      let y = Math.max(2, Math.min(WORLD_HEIGHT - 3, Math.floor(b.y + (Math.random() - 0.5) * 16)));
      if (!w.isLoaded(x, z)) continue;
      while (y > 1 && !block(w.blockAt(x, y - 1, z)).solid) y--;
      const floor = w.blockAt(x, y - 1, z);
      if (!block(floor).solid || floor === B.LAVA || block(w.blockAt(x, y, z)).solid || block(w.blockAt(x, y + 1, z)).solid || isFluid(w.blockAt(x, y, z))) continue;
      this.particles("portal", b.x, b.y + 1, b.z, 16);
      this.teleportLocal(x + 0.5, y, z + 0.5);
      this.sound("chorus_fruit_teleport", x + 0.5, y, z + 0.5, 0.8);
      return;
    }
  }

  /** Frames that just took an eye: the one that completes a ring of twelve fills it with portal. */
  private lightEndPortals(): void {
    const w = this.world;
    for (const [x, y, z] of this.endPortalChecks.splice(0)) {
      const cells = findEndPortal((a, b2, c) => w.blockAt(a, b2, c), (a, b2, c) => w.getMeta(a, b2, c), x, y, z);
      if (!cells) continue;
      for (const [cx, cy, cz] of cells) w.setBlock(cx, cy, cz, B.END_PORTAL, 0, "world");
      this.sound("end_portal_spawn", x + 0.5, y + 0.5, z + 0.5, 3);
    }
  }

  /** Throws an eye of ender from here toward the nearest stronghold (the host's, or a guest's thrown for them). */
  throwEye(x: number, y: number, z: number, owner: string): void {
    const eye = new Projectile("eye_of_ender", x, y, z, 0, 0, 0, owner);
    eye.item = itemId("eye_of_ender");
    const s = nearestStronghold(this.meta.seed, x, z);
    eye.signalTo(s.x + 0.5, s.y, s.z + 0.5, Math.random);
    this.spawn(eye);
    this.sound("eye_of_ender_launch", x, y, z, 1);
  }

  /** Sets an end crystal on the block top at x, y, z; four on the exit portal's rim summon the dragon again. */
  placeCrystal(x: number, y: number, z: number): void {
    if (!this.simulates) return;
    const cx = x + 0.5, cy = y + 1, cz = z + 0.5;
    if ([...this.entities.values()].some((e) => e instanceof EndCrystal && Math.abs(e.x - cx) < 1 && Math.abs(e.y - cy) < 1 && Math.abs(e.z - cz) < 1)) return;
    this.spawn(new EndCrystal(cx, cy, cz));
    if (this.dimension === "end") this.endFight.crystalPlaced();
  }

  /** The dragon egg flees a touch: it blinks to a free spot up to eight blocks away. */
  teleportEgg(x: number, y: number, z: number): void {
    const w = this.world;
    for (let i = 0; i < 200; i++) {
      const tx = x + Math.floor(Math.random() * 17) - 8, ty = y + Math.floor(Math.random() * 9) - 4, tz = z + Math.floor(Math.random() * 17) - 8;
      if (ty < 1 || ty >= WORLD_HEIGHT - 1 || w.getBlock(tx, ty, tz) !== B.AIR) continue;
      w.setBlock(x, y, z, B.AIR, 0, "player");
      w.setBlock(tx, ty, tz, B.DRAGON_EGG, 0, "player");
      this.particles("portal", x + 0.5, y + 0.5, z + 0.5, 16);
      this.particles("portal", tx + 0.5, ty + 0.5, tz + 0.5, 16);
      return;
    }
  }

  /** Lands the player once the destination has loaded. Returns false while still waiting. */
  private settleArrival(a: Arrival): boolean {
    const w = this.world;
    const x = Math.floor(a.x), z = Math.floor(a.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!w.isLoaded(x + dx * 16, z + dz * 16)) return false;
    const b = this.player.body;
    if (a.kind === "portal") {
      let spot: { x: number; y: number; z: number; axis: PortalAxis } | null = null;
      if (a.known && w.blockAt(a.x, a.y, a.z) === B.NETHER_PORTAL) spot = a;
      else if (a.known) {
        // Broken since: forget it, and build a new one where it stood.
        const list = this.meta.portals?.[this.dimension];
        if (list) this.meta.portals![this.dimension] = list.filter(([px, py, pz]) => px !== a.x || py !== a.y || pz !== a.z);
      }
      if (!spot) {
        const [yMin, yMax] = this.dimension === "nether" ? [NETHER_LAVA_LEVEL + 2, 116] : [2, WORLD_HEIGHT - 8];
        const plan = planPortal((px, py, pz) => w.getBlock(px, py, pz), a.x, a.y, a.z, a.axis, 16, yMin, yMax);
        for (const [px, py, pz, id, m] of plan.blocks) w.setBlock(px, py, pz, id, m, "world");
        this.recordPortal(this.dimension, plan.x, plan.y, plan.z, plan.axis);
        spot = plan;
      }
      b.x = spot.x + (spot.axis === 0 ? 1 : 0.5);
      b.z = spot.z + (spot.axis === 0 ? 0.5 : 1);
      b.y = spot.y;
    } else if (a.kind === "platform") {
      // A five-by-five obsidian floor over the void, with room cleared above it: built fresh every arrival.
      const px = Math.floor(a.x), py = Math.floor(a.y), pz = Math.floor(a.z);
      if (this.simulates) {
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          w.setBlock(px + dx, py - 1, pz + dz, B.OBSIDIAN, 0, "world");
          for (let dy = 0; dy <= 2; dy++) w.setBlock(px + dx, py + dy, pz + dz, B.AIR, 0, "world");
        }
      }
      b.x = px + 0.5; b.y = py; b.z = pz + 0.5;
      // Facing the island.
      this.player.yaw = Math.PI / 2;
    } else if (a.kind === "gateway") {
      if (a.inner) {
        // Onto the top of the gateway's cage; if this pair's near end never opened, it opens now.
        const [gx, gy, gz] = gatewayPosition(a.index);
        if (w.blockAt(gx, gy + 2, gz) !== B.BEDROCK && this.simulates) buildGateway((px, py, pz, id, m = 0) => { w.setBlock(px, py, pz, id, m, "world"); }, gx, gy, gz);
        if (w.blockAt(gx, gy + 2, gz) === B.BEDROCK) { b.x = gx + 0.5; b.y = gy + 3; b.z = gz + 0.5; }
        else { const ground = this.groundNear(x, z); if (ground) { b.x = ground.x; b.y = ground.y; b.z = ground.z; } }
      } else {
        const ground = this.groundNear(x, z);
        if (ground) { b.x = ground.x; b.y = ground.y; b.z = ground.z; }
      }
    } else if (a.kind === "exact") {
      // A guest waits (a while) to hear where the host landed, rather than guessing and falling.
      if (a.wait !== undefined && performance.now() < a.wait) return false;
      // The nearest spot beside the host with floor under it and room to stand (portals are walked through);
      // failing that, straight up out of whatever is solid.
      const hy = Math.floor(a.y);
      const free = (fx: number, fy: number, fz: number) =>
        !block(w.blockAt(fx, fy, fz)).solid && !block(w.blockAt(fx, fy + 1, fz)).solid && block(w.blockAt(fx, fy - 1, fz)).solid
        && !isFluid(w.blockAt(fx, fy, fz)) && !isFluid(w.blockAt(fx, fy - 1, fz));
      let spot: [number, number, number] | null = null;
      for (let r = 1; r <= 3 && !spot; r++) {
        for (const dy of [0, 1, -1, 2]) for (let dz = -r; dz <= r && !spot; dz++) for (let dx = -r; dx <= r && !spot; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) === r && free(x + dx, hy + dy, z + dz)) spot = [x + dx, hy + dy, z + dz];
        }
      }
      if (spot) { b.x = spot[0] + 0.5; b.y = spot[1]; b.z = spot[2] + 0.5; }
      else {
        let y = hy;
        while (y < WORLD_HEIGHT - 2 && (block(w.blockAt(x, y, z)).solid || block(w.blockAt(x, y + 1, z)).solid)) y++;
        b.x = a.x; b.y = y; b.z = a.z;
      }
    } else {
      const ground = this.groundNear(x, z);
      if (ground) { b.x = ground.x; b.y = ground.y; b.z = ground.z; }
    }
    this.player.prevX = b.x; this.player.prevY = b.y; this.player.prevZ = b.z;
    b.vx = b.vy = b.vz = 0;
    return true;
  }

  // ---- spawners ----------------------------------------------------------------------------

  /** Spawner blocks in loaded chunks and ticks until each next breeds. */
  private spawners = new Map<string, number>();

  private findSpawners(cx: number, cz: number): void {
    const c = this.world.chunk(cx, cz);
    if (!c) return;
    for (let i = c.blocks.indexOf(B.SPAWNER); i >= 0; i = c.blocks.indexOf(B.SPAWNER, i + 1)) {
      const x = cx * 16 + (i & 15), z = cz * 16 + ((i >> 4) & 15), y = i >> 8;
      this.spawners.set(`${x},${y},${z}`, 100 + Math.floor(Math.random() * 400));
    }
  }

  /** A spawner with a player within sixteen blocks breeds up to four of its mob every ten to forty seconds. */
  private tickSpawners(refs: PlayerRef[]): void {
    for (const [key, delay] of this.spawners) {
      const [x, y, z] = key.split(",").map(Number);
      if (!this.world.isLoaded(x, z)) { this.spawners.delete(key); continue; }
      if (this.world.blockAt(x, y, z) !== B.SPAWNER) { this.spawners.delete(key); continue; }
      if (!refs.some((r) => Math.hypot(r.x - x, r.y - y, r.z - z) <= 16)) continue;
      if (this.tickCount % 10 === 0) this.particles("flame", x + 0.5, y + 0.5, z + 0.5, 1, 0, false);
      if (delay > 0) { this.spawners.set(key, delay - 1); continue; }
      this.spawners.set(key, 200 + Math.floor(Math.random() * 600));
      if (this.meta.difficulty === 0) continue;
      const kind = SPAWNER_MOBS[this.world.getMeta(x, y, z) % SPAWNER_MOBS.length] as MobKind;
      if (!MOB_KINDS.includes(kind)) continue;
      const near = [...this.entities.values()].filter((e) => e instanceof Mob && e.kind === kind && Math.hypot(e.x - x, e.z - z) < 9).length;
      for (let n = 0; n < 4 && near + n < 6; n++) {
        const sx = x + Math.floor((Math.random() - 0.5) * 8), sy = y + Math.floor(Math.random() * 3) - 1, sz = z + Math.floor((Math.random() - 0.5) * 8);
        if (block(this.world.blockAt(sx, sy, sz)).solid || block(this.world.blockAt(sx, sy + 1, sz)).solid) continue;
        if (!block(this.world.blockAt(sx, sy - 1, sz)).solid && kind !== "blaze") continue;
        this.spawn(new Mob(kind, sx + 0.5, sy, sz + 0.5));
        this.particles("smoke", sx + 0.5, sy + 0.5, sz + 0.5, 8);
      }
    }
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
      const st = sanitizeStack(s.data?.stack);
      if (st) e = new ItemEntity(s.x, s.y, s.z, st, 0, s.id);
    } else if (s.kind === "xp") {
      e = new XpOrb(s.x, s.y, s.z, Number(s.data?.value ?? 1), s.id);
    } else if (s.kind === "end_crystal") {
      e = new EndCrystal(s.x, s.y, s.z, s.data?.b !== 0, s.id);
    } else {
      e = vehicleFromSnapshot(s);
      // Nobody is riding anything when a world opens.
      if (e instanceof Vehicle) e.rider = null;
    }
    if (e) {
      bumpEntityIds(e.id);
      this.entities.set(e.id, e);
    }
  }

  private redstoneContext(): RedstoneContext {
    return {
      sound: (name, x, y, z, v, p) => this.sound(name, x, y, z, v, p),
      particles: (kind, x, y, z, count) => this.particles(kind, x, y, z, count ?? 1),
      dropItems: (x, y, z, stacks) => { for (const s of stacks) this.dropItem(x, y, z, s); },
      primeTnt: (x, y, z) => {
        this.spawn(new PrimedTnt(x + 0.5, y, z + 0.5, 80));
        this.sound("fuse", x + 0.5, y + 0.5, z + 0.5);
      },
      bodies: () => this.redstoneBodies(),
      takeItemsIn: (x0, y0, z0, x1, y1, z1, take) => {
        for (const e of this.entities.values()) {
          if (!(e instanceof ItemEntity) || e.removed || e.pickupDelay > 0) continue;
          const b = e.body;
          if (b.x < x0 || b.x >= x1 || b.y < y0 || b.y >= y1 || b.z < z0 || b.z >= z1) continue;
          const n = take(e.stack);
          if (n >= e.stack.count) e.removed = true;
          else if (n > 0) e.stack = { ...e.stack, count: e.stack.count - n };
        }
      },
      dispense: (x, y, z, face, stack) => this.dispense(x, y, z, face, stack),
      dropOne: (x, y, z, face, stack) => {
        const [dx, dy, dz] = FACE_DIRS[face];
        this.dropItem(x + 0.5 + dx * 0.7, y + 0.35 + dy * 0.7, z + 0.5 + dz * 0.7, { ...stack, count: 1 },
          dx * 0.25 + (Math.random() - 0.5) * 0.05, 0.1 + dy * 0.25, dz * 0.25 + (Math.random() - 0.5) * 0.05, null, 5);
      },
      sunlight: () => this.sunlight(),
      containerChanged: (x, y, z) => this.containerChanged(x, y, z),
      ensureContainer: (x, y, z) => this.containerAt(x, y, z, "chest"),
    };
  }

  /** Players (here and online) and entities, as things a pressure plate feels and a piston shoves. */
  private redstoneBodies(): RedstoneBody[] {
    const out: RedstoneBody[] = [];
    const p = this.player, pb = p.body;
    if (!p.dead && p.gameMode !== "spectator") {
      out.push({ x: pb.x, y: pb.y, z: pb.z, width: pb.width, height: pb.height, mob: true, move: (dx, dy, dz) => { pb.x += dx; pb.y += dy; pb.z += dz; } });
    }
    for (const r of this.remote.values()) {
      if (r.dead || r.gameMode === "spectator") continue;
      out.push({ x: r.x, y: r.y, z: r.z, width: 0.6, height: 1.8, mob: true, move: (dx, dy, dz) => this.net?.pushRemote?.(r.id, dx, dy, dz) });
    }
    for (const e of this.entities.values()) {
      if (e.removed) continue;
      const b = e.body;
      out.push({ x: b.x, y: b.y, z: b.z, width: b.width, height: b.height, mob: e instanceof Mob, cart: e instanceof Minecart, move: (dx, dy, dz) => { b.x += dx; b.y += dy; b.z += dz; } });
    }
    return out;
  }

  /**
   * What a dispenser does with an item: arrows and snowballs fly, buckets fill
   * and empty, TNT is lit, bone meal grows what is in front. Returns what is
   * left in the slot, or undefined to have the item simply dropped.
   */
  private dispense(x: number, y: number, z: number, face: number, stack: ItemStack): Slot | undefined {
    const name = itemDef(stack.id)?.name;
    const [dx, dy, dz] = FACE_DIRS[face];
    const fx = x + dx, fy = y + dy, fz = z + dz;
    const less: Slot = stack.count > 1 ? { ...stack, count: stack.count - 1 } : null;
    const w = this.world;
    const use = itemDef(stack.id)?.use;
    if (name === "arrow" || name === "snowball" || name === "egg" || use === "splash" || use === "xp_bottle") {
      const kind: ProjectileKind = use === "splash" ? "potion" : use === "xp_bottle" ? "xp_bottle" : (name as ProjectileKind);
      const speed = name === "arrow" ? 1.1 : kind === "potion" || kind === "xp_bottle" ? 0.6 : 0.9;
      const spread = () => (Math.random() - 0.5) * 0.08;
      const proj = new Projectile(kind, x + 0.5 + dx * 0.7, y + 0.5 + dy * 0.7, z + 0.5 + dz * 0.7,
        dx * speed + spread(), dy * speed + 0.1 + spread(), dz * speed + spread(), null);
      proj.item = kind === "potion" ? stack.id : 0;
      this.spawn(proj);
      this.sound(name === "arrow" ? "bow" : "throw", x + 0.5, y + 0.5, z + 0.5, 0.6);
      return less;
    }
    if (name === "water_bucket" || name === "lava_bucket") {
      const cur = w.blockAt(fx, fy, fz);
      if (cur !== 0 && !(block(cur).replaceable && !isFluid(cur))) return undefined;
      if (name === "water_bucket" && DIMENSION_INFO[this.dimension].waterEvaporates) {
        this.sound("fizz", fx + 0.5, fy + 0.5, fz + 0.5, 0.6);
        return { id: itemId("bucket"), count: 1 };
      }
      w.setBlock(fx, fy, fz, name === "water_bucket" ? B.WATER : B.LAVA, 0, "world");
      this.sound("bucket_empty", fx + 0.5, fy + 0.5, fz + 0.5);
      return { id: itemId("bucket"), count: 1 };
    }
    if (name === "bucket") {
      const cur = w.blockAt(fx, fy, fz);
      if (!isFluid(cur) || (w.getMeta(fx, fy, fz) & 15) !== 0) return undefined;
      w.setBlock(fx, fy, fz, B.AIR, 0, "world");
      const full: ItemStack = { id: itemId(cur === B.WATER ? "water_bucket" : "lava_bucket"), count: 1 };
      this.sound("bucket_fill", fx + 0.5, fy + 0.5, fz + 0.5);
      if (stack.count === 1) return full;
      this.dropItem(fx + 0.5, fy + 0.3, fz + 0.5, full);
      return less;
    }
    if (name === "bone_meal") {
      if (this.rules.boneMeal(fx, fy, fz)) {
        this.particles("crit", fx + 0.5, fy + 0.8, fz + 0.5, 8);
        return less;
      }
      return stack;
    }
    if (name === "tnt") {
      if (w.blockAt(fx, fy, fz) !== 0 && block(w.blockAt(fx, fy, fz)).solid) return undefined;
      this.spawn(new PrimedTnt(fx + 0.5, fy, fz + 0.5, 80));
      this.sound("fuse", fx + 0.5, fy + 0.5, fz + 0.5);
      return less;
    }
    if (name === "flint_and_steel") {
      if (w.blockAt(fx, fy, fz) === B.AIR) {
        // Sets fire in front, as the original's dispenser does.
        w.setBlock(fx, fy, fz, B.FIRE, 0, "world");
        this.sound("ignite", fx + 0.5, fy + 0.5, fz + 0.5);
      } else if (w.blockAt(fx, fy, fz) !== B.TNT) return stack;
      else {
        w.setBlock(fx, fy, fz, B.AIR, 0, "world");
        this.spawn(new PrimedTnt(fx + 0.5, fy, fz + 0.5, 80));
        this.sound("fuse", fx + 0.5, fy + 0.5, fz + 0.5);
      }
      const used = (stack.damage ?? 0) + 1;
      return used >= (itemDef(stack.id)?.durability ?? 64) ? null : { ...stack, damage: used };
    }
    return undefined;
  }

  /** How bright the sun itself is (0 at night): daylight without the floor that keeps nights visible. */
  sunlight(): number {
    const angle = ((this.time % DAY_TICKS) / DAY_TICKS) * Math.PI * 2;
    const d = Math.max(0, Math.min(1, Math.sin(angle) * 2.2 + 0.2));
    return d * (1 - this.rain * 0.25 - this.thunder * 0.25);
  }

  private makeContext(): EntityContext {
    // The getters below run with `this` bound to the object literal, so they need the game by name.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const game = this;
    return {
      // A getter: the world is replaced when the player changes dimension.
      get world() { return game.world; },
      get tick() { return game.tickCount; },
      get daylight() { return game.daylight(); },
      get difficulty() { return game.meta.difficulty; },
      random: Math.random,
      players: () => this.playerRefs(),
      hurtPlayer: (id, amount, source, fx, fz, kb, attacker) => {
        if (id === this.player.id) this.hurtLocal(amount, source, fx, fz, kb, attacker);
        else this.net?.hurtRemote(id, amount, source, fx, fz, kb, attacker);
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
        if (id === this.player.id) this.collectXp(amount);
        else this.net?.xpRemote(id, amount);
      },
      splashPotion: (item, x, y, z, direct, owner) => this.splashPotion(item, x, y, z, direct, owner),
      effectPlayer: (id, effect, seconds, amp) => {
        if (id === this.player.id) this.player.applyEffect(effect, seconds, amp);
        else this.net?.effectRemote?.(id, effect, seconds, amp);
      },
      spawn: (e) => this.spawn(e),
      dropItem: (x, y, z, stack, vx, vy, vz) => this.dropItem(x, y, z, stack, vx, vy, vz),
      explode: (x, y, z, power, cause, fire) => this.explode(x, y, z, power, cause, fire),
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
      creditKill: (id, hostile) => {
        if (id === this.player.id) this.advance({ kind: "kill", hostile });
        else this.net?.advanceRemote?.(id, { kind: "kill", hostile });
      },
      pearlLanded: (id, x, y, z, gateway) => this.pearlLanded(id, x, y, z, gateway),
      crystalDestroyed: (crystal, attacker) => { if (crystal instanceof EndCrystal) this.endFight.crystalDestroyed(crystal, attacker); },
      dragonDefeated: () => this.endFight.defeated(),
      get mobGriefing() { return game.meta.rules.mobGriefing; },
      get raining() { return DIMENSION_INFO[game.dimension].hasSky && game.rain > 0.5; },
    };
  }

  playerRefs(): PlayerRef[] {
    const p = this.player;
    const refs: PlayerRef[] = [];
    if (!p.dead) {
      refs.push({
        id: p.id, name: p.name, x: p.body.x, y: p.body.y, z: p.body.z, width: p.body.width, height: p.body.height,
        targetable: p.survivalLike, heldItem: p.inventory.held?.id ?? -1, sneaking: p.sneaking, invisible: p.hasEffect("invisibility"),
        goldArmor: p.inventory.armor.some((a) => !!a && itemDef(a.id)?.armor?.material === "golden"),
        yaw: p.yaw, pitch: p.pitch, pumpkin: p.inventory.armor[0]?.id === B.CARVED_PUMPKIN,
      });
    }
    for (const r of this.remote.values()) {
      if (r.dead) continue;
      refs.push({
        id: r.id, name: r.name, x: r.x, y: r.y, z: r.z, width: 0.6, height: r.sneaking ? 1.5 : 1.8,
        targetable: r.gameMode === "survival" || r.gameMode === "adventure", heldItem: r.held ?? -1, sneaking: r.sneaking, invisible: r.invisible,
        goldArmor: r.goldArmor, yaw: r.yaw, pitch: r.pitch, pumpkin: r.pumpkin,
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

  /** `fire` leaves flames among the rubble (a bed in the Nether, a ghast's fireball). */
  explode(x: number, y: number, z: number, power: number, cause: Entity | null, fire = false): void {
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
    if (fire) {
      const r = Math.ceil(power);
      for (let n = 0; n < power * 6; n++) {
        const fx = Math.floor(x + (Math.random() - 0.5) * 2 * r), fy = Math.floor(y + (Math.random() - 0.5) * 2 * r), fz = Math.floor(z + (Math.random() - 0.5) * 2 * r);
        if (this.world.blockAt(fx, fy, fz) === B.AIR && block(this.world.blockAt(fx, fy - 1, fz)).solid && Math.random() < 0.34) {
          this.world.setBlock(fx, fy, fz, B.FIRE, 1, "world");
        }
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
      // A crystal's blast never touches the dragon it serves; another crystal it sets off.
      if (e instanceof Mob && e.kind === "ender_dragon" && cause instanceof EndCrystal) continue;
      if (e instanceof Mob || e instanceof Vehicle || e instanceof EndCrystal) e.hurt(this.ctx, hit.damage, "explosion", x, z);
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
    // A pumpkin set on a T of iron blocks may wake a golem; checked after the change settles.
    if (this.simulates && (c.id === B.CARVED_PUMPKIN || c.id === B.JACK_O_LANTERN)) this.golemChecks.push([c.x, c.y, c.z]);
    // An eye set in a frame, here or by a guest: the twelfth lights the portal.
    if (this.simulates && c.id === B.END_PORTAL_FRAME && (c.meta & FRAME_EYE) !== 0 && (c.prevMeta & FRAME_EYE) === 0) this.endPortalChecks.push([c.x, c.y, c.z]);
  }

  private golemChecks: [number, number, number][] = [];
  private endPortalChecks: [number, number, number][] = [];

  /** Iron blocks in a T with a pumpkin for a head come alive as an iron golem, as in the original. */
  private buildGolems(): void {
    const w = this.world;
    for (const [x, y, z] of this.golemChecks.splice(0)) {
      const parts = golemParts((a, b, c) => w.blockAt(a, b, c), x, y, z);
      if (!parts) continue;
      for (const [px, py, pz] of parts) {
        w.setBlock(px, py, pz, B.AIR, 0, "world");
        this.particles("block", px + 0.5, py + 0.5, pz + 0.5, 8, B.IRON_BLOCK);
      }
      const golem = new Mob("iron_golem", x + 0.5, y - 2, z + 0.5);
      golem.home = { x: x + 0.5, z: z + 0.5 };
      this.spawn(golem);
      this.sound("anvil_use", x + 0.5, y - 1, z + 0.5, 0.8, 0.6);
    }
  }

  /** A freshly generated chunk's structures come alive: villages here, fortresses in the Nether. */
  private settleStructures(cx: number, cz: number): void {
    if (this.dimension === "overworld") {
      this.settleVillages(cx, cz);
      if (this.generator instanceof Generator) {
        for (const s of this.generator.strongholdsAt(cx, cz)) this.fillChests(cx, cz, s.chests.map(([x, y, z, room]) => [x, y, z, (items) => strongholdLoot(items, hash4(this.meta.seed ^ 0x57, x, y, z), room)]));
      }
    }
    else if (this.dimension === "nether") {
      const w = this.world;
      for (const f of fortressesTouching(this.meta.seed, cx, cz)) {
        this.fillChests(cx, cz, f.chests.map(([x, y, z]) => [x, y, z, (items) => fortressLoot(items, hash4(this.meta.seed ^ 0x4e, x, y, z))]));
      }
    }
    if (this.dimension === "end" && this.generator instanceof EndGenerator) {
      for (const c of endCitiesTouching(this.generator, cx, cz)) {
        this.fillChests(cx, cz, c.chests.map(([x, y, z, kind]) => [x, y, z, (items) => cityLoot(items, hash4(this.meta.seed ^ 0xe7, x, y, z), kind === "ship")]));
      }
    }
    this.findSpawners(cx, cz);
  }

  /** Puts loot in a structure's chests that stand in chunk (cx, cz) and are still empty chests there. */
  private fillChests(cx: number, cz: number, chests: [number, number, number, (items: (ItemStack | null)[]) => void][]): void {
    const w = this.world;
    for (const [x, y, z, fill] of chests) {
      if (x >> 4 !== cx || z >> 4 !== cz || w.blockAt(x, y, z) !== B.CHEST || w.getEntity(x, y, z)) continue;
      const chest = newChest(27);
      fill(chest.items);
      w.setEntity(x, y, z, chest);
    }
  }

  /**
   * A freshly generated chunk's share of any village: loot in its house chests,
   * and — once per village, when its well's chunk first appears — its
   * villagers at their stations and an iron golem by the well.
   */
  private settleVillages(cx: number, cz: number): void {
    const w = this.world;
    if (!(this.generator instanceof Generator)) return;
    const done = (this.meta.villages ??= []);
    for (const v of this.generator.villagesAt(cx, cz)) {
      for (const h of v.houses) {
        if (!h.chest) continue;
        const [x, y, z] = h.chest;
        if (x >> 4 !== cx || z >> 4 !== cz || w.blockAt(x, y, z) !== B.CHEST || w.getEntity(x, y, z)) continue;
        const chest = newChest(27);
        villageLoot(chest.items, hash4(this.meta.seed, x, y, z));
        w.setEntity(x, y, z, chest);
      }
      if (v.x >> 4 !== cx || v.z >> 4 !== cz || done.includes(v.key)) continue;
      done.push(v.key);
      for (const h of v.houses) {
        const [jx, jy, jz] = h.job;
        // One step from the station toward the door: the station stands against the back wall.
        const m = new Mob("villager", jx + 0.5 + (h.front === 3 ? 1 : h.front === 2 ? -1 : 0), jy, jz + 0.5 + (h.front === 1 ? 1 : h.front === 0 ? -1 : 0));
        m.setProfession(h.profession);
        m.job = h.job;
        m.home = { x: v.x, z: v.z };
        this.spawn(m);
      }
      const golem = new Mob("iron_golem", v.x + 3.5, v.y + 1, v.z + 3.5);
      golem.home = { x: v.x, z: v.z };
      this.spawn(golem);
    }
  }

  /** Spills a container's contents when it is broken. */
  dropContainerContents(x: number, y: number, z: number): void {
    const e = this.world.getEntity(x, y, z);
    if (!e) return;
    const stacks = entityStacks(e);
    for (const s of stacks) if (s) this.dropItem(x + 0.5, y + 0.5, z + 0.5, s);
    if (e.kind === "furnace" && e.xp > 0) this.spawnXp(x + 0.5, y + 0.5, z + 0.5, Math.floor(e.xp));
    this.world.setEntity(x, y, z, undefined);
  }

  containerAt(x: number, y: number, z: number, kind: "chest" | "furnace" | "brewing"): BlockEntity {
    let e = this.world.getEntity(x, y, z);
    if (!e || e.kind !== kind) {
      e = kind === "chest" ? newChest(containerSize(this.world.blockAt(x, y, z)) || 27) : kind === "brewing" ? newBrewing() : newFurnace();
      this.world.setEntity(x, y, z, e);
    }
    return e;
  }

  /** A container changed from this client: save it and tell the others. */
  containerChanged(x: number, y: number, z: number): void {
    const c = this.world.chunkAt(x, z);
    if (c) { c.modified = true; this.dirtySave.add(c.id); }
    this.net?.blockEntity(x, y, z, this.world.getEntity(x, y, z) ?? null);
    // Comparators reading this container look again.
    if (this.simulates) this.redstone.containerChanged(x, y, z);
    const s = this.screen;
    if (s && (s.kind === "chest" || s.kind === "furnace" || s.kind === "brewing") && s.x === x && s.y === y && s.z === z) this.bumpInv();
  }

  private tickFurnaces(): void {
    for (const c of this.world.loadedChunks()) {
      for (const [index, e] of c.entities) {
        const x = c.cx * 16 + (index & 15), z = c.cz * 16 + ((index >> 4) & 15), y = index >> 8;
        if (e.kind === "brewing") { this.tickBrewingStand(c, e, x, y, z); continue; }
        if (e.kind !== "furnace") continue;
        if (this.tickFurnace(e, x, y, z)) {
          c.modified = true;
          this.dirtySave.add(c.id);
          if (this.tickCount % 10 === 0) {
            this.net?.blockEntity(x, y, z, e);
            this.redstone.containerChanged(x, y, z);
          }
          if (this.screen?.kind === "furnace" && this.screen.x === x && this.screen.y === y && this.screen.z === z) this.bumpInv();
        }
      }
    }
  }

  private tickBrewingStand(c: Chunk, e: BrewingEntity, x: number, y: number, z: number): void {
    if (this.world.blockAt(x, y, z) !== B.BREWING_STAND) return;
    const r = tickBrewing(e);
    // The stand shows a bottle for each filled slot; keep its look in step with what it holds.
    const bits = bottleBits(e);
    if ((this.world.getMeta(x, y, z) & 7) !== bits) {
      this.world.setBlock(x, y, z, B.BREWING_STAND, bits, "world");
      this.world.setEntity(x, y, z, e);
    }
    if (!r.changed) return;
    c.modified = true;
    this.dirtySave.add(c.id);
    if (r.finished) {
      this.sound("brew", x + 0.5, y + 0.5, z + 0.5, 0.8);
      this.net?.blockEntity(x, y, z, e);
      this.redstone.containerChanged(x, y, z);
      // Whoever has the stand open saw it done.
      if (this.screen?.kind === "brewing" && this.screen.x === x && this.screen.y === y && this.screen.z === z) this.advance({ kind: "brew" });
    } else if (this.tickCount % 10 === 0) this.net?.blockEntity(x, y, z, e);
    if (this.screen?.kind === "brewing" && this.screen.x === x && this.screen.y === y && this.screen.z === z) this.bumpInv();
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

  hurtLocal(amount: number, source: DamageSource, fx?: number, fz?: number, kb = 0, attacker?: number): void {
    if (!this.meta.rules.doFallDamage && source === "fall") return;
    const dealt = this.player.hurt(amount, source, fx, fz, kb);
    // A fireball's heat stays: the player burns for a few seconds after the hit.
    if (source === "fireball" && dealt > 0 && !this.player.hasEffect("fire_resistance")) this.player.fireTicks = Math.max(this.player.fireTicks, 100);
    if (dealt > 0 || kb > 0) {
      this.lastHurtAt = performance.now();
      this.hurtTilt = 1;
    }
    if (dealt > 0 && attacker !== undefined) this.thorns(attacker);
  }

  /** Thorns: each piece has a chance to hurt the mob that struck, at the cost of extra wear. */
  private thorns(attacker: number): void {
    const inv = this.player.inventory;
    let damage = 0;
    inv.armor = inv.armor.map((a) => {
      const lvl = levelOf(a, "thorns");
      if (!a || !lvl || Math.random() >= 0.15 * lvl) return a;
      damage += 1 + Math.floor(Math.random() * 4);
      const max = itemDef(a.id)?.durability ?? 0;
      const worn = (a.damage ?? 0) + 2;
      return max && worn >= max ? null : { ...a, damage: worn };
    });
    if (!damage) return;
    const b = this.player.body;
    const mob = this.entities.get(attacker);
    // The host owns every mob; a guest asks it to deal the damage.
    if (this.role === "guest") this.net?.attack(attacker, damage, b.x, b.z);
    else if (mob instanceof Mob) mob.hurt(this.ctx, damage, "player", b.x, b.z, this.player.id);
    this.bumpInv();
  }

  /** Experience picked up: Mending spends it on worn gear first, two durability a point, as in the original. */
  collectXp(amount: number): void {
    const inv = this.player.inventory;
    const mendable = () => [inv.selected, -1, -2, -3, -4, -5].filter((i) => {
      const s = i >= 0 ? inv.slots[i] : i === -1 ? inv.offhand : inv.armor[-i - 2];
      return !!s && levelOf(s, "mending") > 0 && (s.damage ?? 0) > 0;
    });
    let left = amount;
    for (let guard = 0; left > 0 && guard < 20; guard++) {
      const slots = mendable();
      if (!slots.length) break;
      const i = slots[Math.floor(Math.random() * slots.length)];
      const s = (i >= 0 ? inv.slots[i] : i === -1 ? inv.offhand : inv.armor[-i - 2])!;
      const repaired = Math.min(s.damage ?? 0, left * 2);
      const mended = { ...s, damage: (s.damage ?? 0) - repaired || undefined };
      if (!mended.damage) delete mended.damage;
      if (i >= 0) inv.slots[i] = mended; else if (i === -1) inv.offhand = mended; else inv.armor[-i - 2] = mended;
      left -= Math.ceil(repaired / 2);
    }
    if (left < amount) this.bumpInv();
    if (left > 0) this.addXp(left);
  }

  /**
   * A splash potion burst: every mob and player within four blocks takes its
   * effects, weaker with distance; whatever it struck takes the full dose.
   */
  splashPotion(item: number, x: number, y: number, z: number, direct: Entity | PlayerRef | null, owner: string | null): void {
    const def = itemDef(item);
    const potion = def ? potionOfItem(def.name) : undefined;
    this.sound("glass_break", x, y, z, 0.8);
    this.particles("potion", x, y, z, 24, potion ? parseInt(potion.potion.color.slice(1), 16) : 0x385dc6);
    if (!potion) return;
    const effects = potion.potion.effects;
    const strength = (ex: number, ey: number, ez: number, hit: boolean) => {
      if (hit) return 1;
      const d = Math.hypot(ex - x, ey - y, ez - z);
      return d > 4 ? 0 : 1 - d / 4;
    };
    const attacker = owner && !owner.startsWith("mob:") ? owner : undefined;
    for (const e of this.entities.values()) {
      if (!(e instanceof Mob) || e.dying) continue;
      const f = strength(e.x, e.y + e.body.height / 2, e.z, e === direct);
      if (f <= 0) continue;
      for (const fx of effects) {
        const instant = fx.effect === "instant_health" || fx.effect === "instant_damage";
        // Instant effects scale by distance; lasting ones shorten with it.
        if (instant) { if (f > 0.5 || e === direct) e.applyEffect(this.ctx, fx.effect, 0, fx.amp, attacker); }
        else e.applyEffect(this.ctx, fx.effect, Math.floor(splashSeconds(fx.seconds) * f), fx.amp, attacker);
      }
    }
    for (const p of this.playerRefs()) {
      const hit = direct !== null && !(direct instanceof Mob) && "id" in direct && typeof direct.id === "string" && direct.id === p.id;
      const f = strength(p.x, p.y + 0.9, p.z, hit);
      if (f <= 0) continue;
      for (const fx of effects) {
        const instant = fx.effect === "instant_health" || fx.effect === "instant_damage";
        if (instant && f <= 0.5 && !hit) continue;
        const seconds = instant ? 0 : Math.floor(splashSeconds(fx.seconds) * f);
        if (!instant && seconds <= 0) continue;
        if (p.id === this.player.id) this.player.applyEffect(fx.effect, seconds, fx.amp);
        else this.net?.effectRemote?.(p.id, fx.effect, seconds, fx.amp);
      }
    }
    this.bumpInv();
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
    // No sun where there is no sky: the Nether and the End sit in one unchanging dusk.
    if (!DIMENSION_INFO[this.dimension].hasSky) return 0.12;
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
    if (was && (was.kind === "inventory" || was.kind === "crafting" || was.kind === "enchanting" || was.kind === "anvil" || was.kind === "smithing")) this.returnGrid();
    if (this.cursor && (!screen || screen.kind === "pause")) {
      const left = this.player.inventory.add(this.cursor);
      if (left > 0) this.actions.throwStack({ ...this.cursor, count: left });
      this.cursor = null;
    }
    if (screen?.kind === "crafting") this.craftGrid = new Array(9).fill(null);
    else if (screen?.kind === "inventory") this.craftGrid = [null, null, null, null];
    // The enchanting table and the anvil hold their two stacks only while open, like a crafting grid.
    else if (screen?.kind === "enchanting" || screen?.kind === "anvil" || screen?.kind === "smithing") { this.craftGrid = [null, null]; this.anvilName = null; }
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
    // Beds are in the overworld: death anywhere else sends the player home (online, a guest respawns by the host).
    if (this.dimension !== "overworld") {
      const host = this.role === "guest" && this.net?.hostConnection ? this.remote.get(this.net.hostConnection) : undefined;
      if (host) {
        p.respawn(host.x + 1, host.y, host.z);
        this.arrival = { kind: "exact", x: host.x + 1, y: host.y, z: host.z };
        this.spawnPlaced = false;
        this.setScreen(null);
        return;
      }
      if (this.simulates) {
        const bed = p.spawn;
        const target = bed ? { x: bed.x + 0.5, y: bed.y + 0.6, z: bed.z + 0.5 } : this.worldSpawn();
        this.changeDimension("overworld", { kind: "spawn", ...target });
      }
    }
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
    // A respawn that changed dimension lands through its arrival, on the ground by the spawn.
    if (this.arrival) { this.arrival = { kind: spawn ? "exact" : "spawn", ...s }; this.needsSurface = false; }
    if (this.meta.hardcore) p.setGameMode("spectator");
    this.spawnPlaced = false;
    this.setScreen(null);
  }

  worldSpawn(): { x: number; y: number; z: number } {
    if (!this.meta.spawn) {
      // Asked from another dimension before the overworld ever settled one: the middle of the map, landed on its ground.
      if (this.dimension !== "overworld") return { x: 0.5, y: SEA_LEVEL + 2, z: 0.5 };
      this.meta.spawn = this.generator.findSpawn();
    }
    return { ...this.meta.spawn };
  }

  /** Moves the player to the top of the ground at their spawn column once that chunk has loaded. */
  private placeAtSpawnIfNeeded(): boolean {
    if (this.spawnPlaced) return true;
    if (this.arrival) {
      if (!this.settleArrival(this.arrival)) return false;
      // A gateway moves only whoever stepped in it; the party follows only a change of dimension.
      const alone = this.arrival.kind === "gateway";
      this.arrival = null;
      this.spawnPlaced = true;
      if (this.net?.role === "host" && !alone) {
        const b = this.player.body;
        this.net.partyLanded?.(b.x, b.y, b.z);
      }
      return true;
    }
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
      sitting: p.riding !== null, gliding: p.gliding,
    };
    const remote: RemotePlayerView[] = [];
    for (const r of this.remote.values()) {
      const t = Math.min(1, (now - r.receivedAt) / 120);
      remote.push({
        id: r.id, name: r.name, x: r.px + (r.x - r.px) * t, y: r.py + (r.y - r.py) * t, z: r.pz + (r.z - r.pz) * t,
        yaw: r.pyaw + angleDiff(r.pyaw, r.yaw) * t, pitch: r.pitch, walk: r.walk, speed: r.speed, swing: r.swing,
        sneaking: r.sneaking, heldItem: r.held, variant: r.variant, hurt: r.hurt, dead: r.dead || r.gameMode === "spectator",
        invisible: r.invisible, sitting: r.riding, gliding: r.gliding,
      });
    }

    const info = DIMENSION_INFO[this.dimension];
    // What drifts in the air of a Nether biome, scattered around the player.
    if (biome.airborne && !this.hudHidden) {
      const n = Math.random() < dt * 30 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const px = ix + (Math.random() - 0.5) * 24, py = eye + (Math.random() - 0.5) * 12, pz = iz + (Math.random() - 0.5) * 24;
        if (this.world.blockAt(Math.floor(px), Math.floor(py), Math.floor(pz)) === B.AIR) this.renderer.particles.emit(biome.airborne, px, py, pz, 1, 0, 0);
      }
    }
    const target = this.actions.target?.block ?? null;
    this.renderer.render({
      dt, alpha,
      camera: { x: ix, y: eye, z: iz, yaw: p.yaw, pitch: p.pitch, fov: this.settings.fov * (p.sprinting ? 1.1 : 1) * (this.actions.bowFov()) },
      perspective: this.perspective,
      bob: { walk, amount: bobAmount },
      hurtTilt: this.hurtTilt,
      time: this.time + alpha,
      rain: info.hasSky ? this.rain : 0,
      thunder: info.hasSky ? this.thunder : 0,
      lightning: this.lightning,
      snowing: info.hasSky && biome.snowy,
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
      dimension: info.hasSky ? undefined : { fog: biome.fog ?? 0x330808, ambient: info.ambient, sky: info.skyLight, open: info.open },
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
    const rules = { difficulty: this.meta.difficulty, naturalRegeneration: this.meta.rules.naturalRegeneration, raining: this.rain > 0.5 };
    const vehicle = this.ridden();
    if (!frozen && vehicle) {
      // Sneak climbs out; everything else steers.
      if (!inputBlocked && c.sneak) this.dismount();
      else {
        vehicle.input = { forward: inputBlocked ? 0 : c.forward, strafe: inputBlocked ? 0 : c.strafe, yaw: p.yaw };
        p.tickRiding(this.world, rules);
      }
    } else if (!frozen) {
      p.tick(this.world, {
        forward: inputBlocked ? 0 : c.forward, strafe: inputBlocked ? 0 : c.strafe,
        jump: !inputBlocked && (c.jump || this.actions.autoJumpNow()), sneak: !inputBlocked && c.sneak, sprint: !inputBlocked && c.sprint,
      }, rules);
    }
    this.handlePlayerEvents(p.events.splice(0));
    this.actions.tick();
    if (!frozen) this.tickPortal();

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
    this.seatRider();

    this.net?.tick();

    if (this.role !== "guest" && ++this.saveTimer >= AUTOSAVE_TICKS) {
      this.saveTimer = 0;
      void this.saveNow().catch((e: Error) => this.message(`Autosave failed: ${e.message}`, "#ff6666"));
    }
    if (this.tickCount % 20 === 0) this.audio.tickMusic(1, !this.isNight());
    if (this.tickCount % 10 === 0) this.advance();
    // Eye Spy: standing in a stronghold's halls.
    if (this.tickCount % 20 === 5 && this.dimension === "overworld" && !this.player.advancements.has("stronghold") && this.meta.type !== "flat"
      && inStronghold(this.meta.seed, this.player.body.x, this.player.body.y, this.player.body.z)) this.advance({ kind: "stronghold" });
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
          this.advance({ kind: "eat" });
          if (itemDef(ev.item)?.name === "chorus_fruit") this.chorusTeleport();
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
    this.redstone.step(world.tick);
    this.rules.randomTicks(this.playerRefs().map((r) => ({ x: r.x, z: r.z })), 4);
    this.tickFurnaces();

    const ctx = this.ctx;
    if (this.dimension === "end") this.endFight.tick();
    for (const e of this.entities.values()) {
      // The dragon flies over chunks nobody has loaded; everything else waits for its ground.
      if (!world.isLoaded(Math.floor(e.x), Math.floor(e.z)) && e.kind !== "ender_dragon") continue;
      // A guest drives the vehicle they ride and reports where it went.
      if (e instanceof Vehicle && e.rider && e.rider !== this.player.id && this.remote.has(e.rider)) continue;
      e.tick(ctx);
    }
    // A vehicle whose rider left the game is free again.
    for (const e of this.entities.values()) {
      if (e instanceof Vehicle && e.rider && e.rider !== this.player.id && !this.remote.has(e.rider)) e.rider = null;
    }
    for (const [id, e] of this.entities) if (e.removed) this.entities.delete(id);

    if (this.golemChecks.length) this.buildGolems();
    if (this.endPortalChecks.length) this.lightEndPortals();
    if (this.tickCount % 20 === 0) this.spawnMobs();
    if (this.spawners.size) this.tickSpawners(this.playerRefs());
    this.sleepTick();
  }

  /** The vehicle this player rides, or null — letting go of one that vanished or was taken. */
  ridden(): Vehicle | null {
    const p = this.player;
    if (p.riding === null) return null;
    const v = this.entities.get(p.riding);
    if (!(v instanceof Vehicle) || v.removed || p.dead || (v.rider !== null && v.rider !== p.id) || (v.rider === null && this.simulates)) {
      this.dismount();
      return null;
    }
    return v;
  }

  /** Climbs into a vehicle: at once here, and on the host too when this is a guest. */
  mount(v: Vehicle): void {
    const p = this.player;
    if (v.rider && v.rider !== p.id) return;
    if (p.riding !== null) this.dismount();
    v.rider = p.id;
    p.riding = v.id;
    p.sleeping = null;
    this.net?.mount?.(v.id, true);
    this.showActionbar("Sneak to get out");
  }

  /** Climbs out, onto a free spot beside the vehicle. */
  dismount(): void {
    const p = this.player;
    if (p.riding === null) return;
    const v = this.entities.get(p.riding);
    p.riding = null;
    if (!(v instanceof Vehicle)) return;
    if (v.rider === p.id) v.rider = null;
    this.net?.mount?.(v.id, false);
    const b = p.body;
    const x = Math.floor(v.x), y = Math.floor(v.y + 0.5), z = Math.floor(v.z);
    const free = (bx: number, by: number, bz: number) =>
      !block(this.world.blockAt(bx, by, bz)).solid && !block(this.world.blockAt(bx, by + 1, bz)).solid && block(this.world.blockAt(bx, by - 1, bz)).solid;
    const spots: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]];
    const spot = spots.find(([dx, dy, dz]) => free(x + dx, y + dy, z + dz));
    if (spot) { b.x = x + spot[0] + 0.5; b.y = y + spot[1]; b.z = z + spot[2] + 0.5; }
    else b.y = v.y + v.body.height + 0.05;
    b.vx = b.vy = b.vz = 0;
    p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
  }

  /** Keeps a rider on their seat after the vehicle moved. */
  private seatRider(): void {
    const v = this.ridden();
    if (!v) return;
    const b = this.player.body;
    b.x = v.x; b.y = v.riderY(); b.z = v.z;
    // A boat turns its rider with it.
    if (v instanceof Boat) this.player.yaw += v.yaw - v.prevYaw;
  }

  /** Puts a vehicle into the world (the host's half of placing one). */
  placeVehicle(kind: string, x: number, y: number, z: number, yaw: number, wood: number): Vehicle | null {
    let v: Vehicle | null = null;
    if (kind === "boat") v = new Boat(x, y, z, wood);
    else if (kind === "minecart" || kind === "tnt_minecart") v = new Minecart(kind, x, y, z);
    if (!v) return null;
    v.yaw = yaw;
    v.prevYaw = yaw;
    this.spawn(v);
    return v;
  }

  private guestTick(): void {
    this.time++;
    const own = this.ridden();
    if (own) {
      // The guest drives its own vehicle here, and tells the host.
      own.tick(this.ctx);
      this.net?.vehiclePose?.(own);
    }
    // Between host snapshots, carry entities along their last velocity.
    for (const e of this.entities.values()) {
      if (e === own) continue;
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
    const sky = DIMENSION_INFO[this.dimension].hasSky;
    this.audio.setRain(sky ? this.rain : 0);
    if (sky && this.thunder > 0.9 && Math.random() < 1 / 400) {
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
      // Villagers and golems belong to their village: they neither count against animals nor despawn.
      if (!(e instanceof Mob) || e.kind === "villager" || e.kind === "iron_golem" || e.kind === "ender_dragon") continue;
      if (e.spec.hostile) {
        hostile++;
        // Despawn monsters nobody is near; peaceful removes them all.
        const nearest = Math.min(...refs.map((r) => Math.hypot(r.x - e.x, r.z - e.z)));
        if (this.meta.difficulty === 0 || nearest > 128 || (nearest > 32 && Math.random() < 1 / 40)) e.removed = true;
      } else passive++;
    }
    const origin = refs[Math.floor(Math.random() * refs.length)];
    if (this.dimension !== "overworld") {
      // Elsewhere, spawning ignores light and follows each biome's list; there are no animals.
      if (hostile < (MAX_HOSTILE + 6) * refs.length) for (let attempt = 0; attempt < 3; attempt++) this.trySpawnElsewhere(origin);
      return;
    }
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
      // Slime chunks breed slimes deep underground whatever the light, which is what makes them findable.
      if (y < 40 && isSlimeChunk(this.meta.seed, x >> 4, z >> 4) && Math.random() < 0.3) {
        this.spawn(new Mob("slime", x + 0.5, y, z + 0.5));
        return;
      }
      if (blockLight > 0 || sky >= 8) return;
      // Swamps add slimes to the night's surface spawns.
      const swamp = biome.id === BiomeId.Swamp && y > SEA_LEVEL - 4;
      const kinds: MobKind[] = swamp ? ["zombie", "skeleton", "creeper", "spider", "slime", "slime"] : ["zombie", "skeleton", "creeper", "spider"];
      // One spawn in twelve is an enderman, alone or in a pair: rarer than the rest, as in the original.
      const kind = Math.random() < 1 / 12 ? "enderman" : kinds[Math.floor(Math.random() * kinds.length)];
      if (kind === "enderman" && (block(this.world.blockAt(x, y + 2, z)).solid)) return;
      const group = kind === "enderman" ? 1 + Math.floor(Math.random() * 2) : 1 + Math.floor(Math.random() * 3);
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

  /**
   * A spawn attempt outside the overworld: a floor 24 to 48 blocks out, a mob
   * from the biome's list — or, inside a fortress, from the fortress's own.
   */
  private trySpawnElsewhere(origin: PlayerRef): void {
    const w = this.world;
    const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 24;
    const x = Math.floor(origin.x + Math.cos(a) * r), z = Math.floor(origin.z + Math.sin(a) * r);
    const chunk = w.chunkAt(x, z);
    if (!chunk) return;
    // A floor: somewhere solid (not lava) with two blocks of air above it, found by walking down.
    let y = Math.floor(origin.y + (Math.random() - 0.5) * 48);
    y = Math.max(2, Math.min(WORLD_HEIGHT - 3, y));
    while (y > 1 && !block(w.blockAt(x, y - 1, z)).solid) y--;
    if (y <= 1 || block(w.blockAt(x, y, z)).solid || block(w.blockAt(x, y + 1, z)).solid || isFluid(w.blockAt(x, y, z))) return;
    const biome = biomeDef(chunk.biomes[((z & 15) << 4) | (x & 15)]);
    const fortress = this.dimension === "nether" && inFortress(this.meta.seed, x, y, z);
    const table: [string, number][] = fortress
      ? [["blaze", 10], ["wither_skeleton", 8], ["zombified_piglin", 5], ["skeleton", 2], ["magma_cube", 3]]
      : biome.spawns ?? [];
    const kinds = table.filter(([k]) => MOB_KINDS.includes(k as MobKind) && (this.meta.difficulty > 0 || !new Mob(k as MobKind, 0, 0, 0).spec.hostile));
    if (!kinds.length) return;
    let roll = Math.random() * kinds.reduce((t, [, wgt]) => t + wgt, 0);
    let kind = kinds[0][0] as MobKind;
    for (const [k, wgt] of kinds) { roll -= wgt; if (roll < 0) { kind = k as MobKind; break; } }
    // Ghasts need room to float: a clear column well above the floor.
    if (kind === "ghast") {
      y += 3;
      for (let dy = 0; dy < 5; dy++) if (block(w.blockAt(x, y + dy, z)).solid) return;
    }
    const group = kind === "ghast" || kind === "blaze" ? 1 : 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < group; i++) {
      const gx = x + (i % 2), gz = z + Math.floor(i / 2);
      if (block(w.blockAt(gx, y, gz)).solid || block(w.blockAt(gx, y + 1, gz)).solid) continue;
      // An enderman stands three blocks tall.
      if (kind === "enderman" && block(w.blockAt(gx, y + 2, gz)).solid) continue;
      this.spawn(new Mob(kind, gx + 0.5, y, gz + 0.5));
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
        if (this.player.sleeping) this.advance({ kind: "sleep" });
        for (const r of this.remote.values()) if (r.sleeping) this.net?.advanceRemote?.(r.id, { kind: "sleep" });
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
      await this.saves.putChunks(this.meta.id, chunks, this.dimension);
      const meta = this.meta;
      meta.time = this.time;
      meta.lastPlayed = Date.now();
      meta.playTime = this.playTimeBase + (performance.now() - this.startedAt) / 1000;
      meta.player = this.player.toJSON();
      meta.dimension = this.dimension;
      meta.entities = this.persistentEntities();
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
    const arriving = this.arrival !== null || (this.dimension !== "overworld" && this.loadingSince > this.startedAt);
    const loading = ready.done < ready.total || !this.spawnPlaced
      ? {
        done: ready.done, total: ready.total,
        message: arriving ? (this.dimension === "overworld" ? "Returning to the Overworld" : `Entering ${DIMENSION_INFO[this.dimension].title}`)
          : this.role === "guest" ? "Joining world" : "Building terrain",
      }
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
      heldName: inv.held ? inv.held.name ?? itemDef(inv.held.id)?.displayName ?? "" : "",
      effects: p.effects.map((e) => ({ kind: e.kind, amp: e.amp, seconds: Math.ceil(e.ticks / 20) })),
      heldNameAt: this.heldNameAt,
      gameMode: p.gameMode,
      hardcore: this.meta.hardcore,
      screen: this.screen,
      chat: this.chatLines.slice(-50),
      dead: p.dead,
      deathMessage: p.deathMessage,
      loading: loading && performance.now() - this.loadingSince < 60000 ? loading : null,
      portal: this.portalTimer > 0 ? Math.min(1, this.portalTimer / 80) : 0,
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
      toasts: this.toasts.filter((t) => performance.now() - t.at < 5000),
      boss: this.endFight.bossBar(),
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

  private toasts: Hud["toasts"] = [];

  /** Records and announces whatever the player has just earned. */
  advance(event?: AdvancementEvent): void {
    const p = this.player;
    if (p.gameMode === "spectator") return;
    for (const a of newlyEarned(p.advancements, { inventory: p.inventory, y: p.body.y, level: p.xpLevel, dimension: this.dimension }, event)) {
      p.advancements.add(a.id);
      this.toasts = [...this.toasts.filter((t) => performance.now() - t.at < 5000), { id: a.id, title: a.title, icon: a.icon, at: performance.now() }];
      this.message(`${p.name} has made the advancement [${a.title}]`, "#55ff55");
      this.net?.chat(`\u0000adv:${p.name} has made the advancement [${a.title}]`);
      this.sound("pop", null, 0, 0, 0.6, 0.7);
    }
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

