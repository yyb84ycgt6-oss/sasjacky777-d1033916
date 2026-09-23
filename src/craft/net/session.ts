/**
 * An online (or same-device) session: one host, any number of guests.
 *
 * The host owns the world. A guest's block edits are applied at once on the
 * guest (so digging feels instant) and sent to the host, which applies them,
 * stamps them with a sequence number and re-broadcasts them; everyone,
 * including the guest who made the edit, converges on the host's order.
 * Water, sand, mobs, time and weather are simulated only by the host and
 * streamed out.
 *
 * Guests generate every untouched chunk themselves from the seed and fetch
 * only chunks the host reports as modified. Edits that arrive for a chunk
 * still loading are held and replayed once it lands, skipping any the
 * fetched copy already contains (by sequence number).
 *
 * Each client sends at most one batched message per ~125 ms, plus the
 * occasional large chunk transfer split into parts.
 */
import type { BlockEntity } from "../engine/chunk";
import { chunkKey } from "../engine/constants";
import {
  Entity, FallingBlock, isProjectileKind, ItemEntity, PrimedTnt, Projectile, XpOrb,
  type DamageSource, type EntitySnapshot, type ProjectileKind,
} from "../engine/entities";
import { itemDef, type ItemStack, type StatusEffect } from "../engine/items";
import { sanitizeStack } from "../engine/inventory";
import { Mob, isMobKind } from "../engine/mobs";
import { isVehicleKind, Vehicle, vehicleFromSnapshot } from "../engine/vehicles";
import { block } from "../engine/blocks";
import type { PlayerSave } from "../engine/player";
import type { AdvancementEvent } from "../engine/advancements";
import type { BlockChange } from "../engine/world";
import type { Game, NetLink, RemotePlayer } from "../game/game";
import { packChunk, toBase64, fromBase64, unpackChunk, type ChunkData, type GameRules } from "../game/save";
import { clientId, connectionId, DeviceTransport, MAX_PART, OnlineTransport, type NetMessage, type Transport } from "./transport";

type Op = unknown[];

export interface Welcome {
  worldName: string;
  seed: number;
  seedText: string;
  type: "default" | "amplified" | "flat" | "large_biomes";
  time: number;
  rain: number;
  thunder: number;
  spawn: { x: number; y: number; z: number } | null;
  rules: GameRules;
  difficulty: 0 | 1 | 2 | 3;
  gameMode: "survival" | "creative" | "adventure" | "spectator";
  hardcore: boolean;
  cheats: boolean;
  modified: string[];
  seq: number;
  player: PlayerSave | null;
  hostId: string;
  hostName: string;
}

const PROTOCOL = 1;
const FLUSH_TICKS = 2;
const ENTITY_TICKS = 4;
const ENV_TICKS = 40;
const PERSIST_TICKS = 200;
const TIMEOUT_MS = 20000;

const finite = (...v: unknown[]) => v.every((n) => typeof n === "number" && Number.isFinite(n));
const int = (v: unknown) => typeof v === "number" && Number.isInteger(v);

export function makeTransport(kind: "online" | "device", room: string): Transport {
  return kind === "online" ? new OnlineTransport(room) : new DeviceTransport(room);
}

export class NetSession implements NetLink {
  readonly role: "host" | "guest";
  readonly room: string;
  readonly kind: "online" | "device";
  private game: Game | null = null;
  private out: Op[] = [];
  private stateOp: Op | null = null;
  private ticks = 0;
  private seq = 0;
  private hostId: string | null = null;
  private lastHost = performance.now();
  private modified = new Set<string>();
  private pendingOps = new Map<string, { seq: number; op: Op }[]>();
  private chunkRequests = new Map<string, { resolve: (d: ChunkData | null) => void; parts: string[]; received: number; timer: ReturnType<typeof setTimeout> }>();
  private requestIds = 0;
  private closed = false;
  private names = new Map<string, string>();
  /** Connection id → the guest's stable player id, which their saved state is filed under. */
  private playerIds = new Map<string, string>();
  status = "connected";

  private constructor(role: "host" | "guest", readonly transport: Transport, room: string, readonly myId: string) {
    this.role = role;
    this.room = room;
    this.kind = transport.kind;
    transport.onMessage((m) => this.receive(m));
    transport.onStatus?.((live) => {
      this.status = live ? "connected" : "reconnecting";
      this.updateStatus();
      this.game?.message(live ? "Reconnected to the online server." : "Lost the online server — reconnecting. Edits made meanwhile are sent when it is back.", live ? "#aaffaa" : "#ffcc55");
    });
  }

  // ---- setup ------------------------------------------------------------------------------

  /** Opens the host's running world to others. */
  static async host(game: Game, kind: "online" | "device", room: string): Promise<NetSession> {
    const t = makeTransport(kind, room);
    if (t instanceof OnlineTransport) await t.ready;
    const s = new NetSession("host", t, room, game.player.id);
    const keys = await game.saves.savedChunkKeys(game.meta.id).catch(() => [] as string[]);
    for (const k of keys) s.modified.add(k);
    for (const c of game.world.loadedChunks()) if (c.modified) s.modified.add(chunkKey(c.cx, c.cz));
    s.attach(game);
    return s;
  }

  /**
   * Joins a room and waits for the host's welcome. Resolves with the session
   * (not yet attached to a game) and what the guest needs to build one; the
   * guest's Player must use `session.myId` so the host's messages reach it.
   */
  static async join(kind: "online" | "device", room: string, name: string, skin: number): Promise<{ session: NetSession; welcome: Welcome }> {
    const t = makeTransport(kind, room);
    if (t instanceof OnlineTransport) await t.ready;
    const myId = connectionId();
    const s = new NetSession("guest", t, room, myId);
    const pid = clientId();
    const welcome = await new Promise<Welcome>((resolve, reject) => {
      const hello = () => t.send({ t: "hello", from: myId, pid, name, skin, v: PROTOCOL });
      hello();
      const again = setInterval(hello, 1500);
      const fail = setTimeout(() => {
        clearInterval(again);
        t.close();
        reject(new Error(`No world is open with the code ${room} right now. Check the code, and that the host has chosen "${kind === "online" ? "Open online" : "Open to tabs on this device"}".`));
      }, 15000);
      s.onWelcome = (w) => {
        clearInterval(again);
        clearTimeout(fail);
        resolve(w);
      };
      s.onRefused = (reason) => {
        clearInterval(again);
        clearTimeout(fail);
        t.close();
        reject(new Error(reason));
      };
    });
    s.hostId = welcome.hostId;
    s.seq = welcome.seq;
    for (const k of welcome.modified) s.modified.add(k);
    s.names.set(welcome.hostId, welcome.hostName);
    return { session: s, welcome };
  }

  private onWelcome: ((w: Welcome) => void) | null = null;
  private onRefused: ((reason: string) => void) | null = null;

  attach(game: Game): void {
    this.game = game;
    game.net = this;
    this.lastHost = performance.now();
    this.updateStatus();
    // Edits broadcast between the welcome and the guest's world existing.
    for (const { from, ops } of this.early.splice(0)) this.onBatch(from, ops);
    game.syncBackground();
  }
  private early: { from: string; ops: Op[] }[] = [];

  close(): void {
    if (this.closed) return;
    // A guest's inventory lives on the host: hand over the latest before leaving.
    if (this.role === "guest" && this.game) this.push(["ps", this.game.player.toJSON()]);
    this.flush();
    this.closed = true;
    this.transport.send({ t: "bye", from: this.myId });
    this.transport.close();
    if (this.game) {
      this.game.remote.clear();
      this.game.setNetStatus(null);
      if (this.game.net === this) this.game.net = null;
    }
  }

  private updateStatus(): void {
    const g = this.game;
    if (!g) return;
    const players = [g.player.name, ...[...g.remote.values()].map((r) => r.name)];
    g.setNetStatus({ role: this.role, room: this.room, kind: this.kind, players, status: this.status });
  }

  // ---- sending ------------------------------------------------------------------------------

  private push(op: Op): void {
    if (!this.closed) this.out.push(op);
  }

  private send(msg: Omit<NetMessage, "from">): void {
    if (!this.closed) this.transport.send({ ...msg, from: this.myId } as NetMessage);
  }

  private flush(): void {
    const ops = this.out.splice(0);
    if (this.stateOp) { ops.unshift(this.stateOp); this.stateOp = null; }
    if (!ops.length) return;
    // Keep each broadcast comfortably under the payload limit.
    let batch: Op[] = [];
    let size = 0;
    for (const op of ops) {
      const len = JSON.stringify(op).length;
      if (size + len > MAX_PART && batch.length) { this.send({ t: "b", ops: batch }); batch = []; size = 0; }
      batch.push(op);
      size += len;
    }
    if (batch.length) this.send({ t: "b", ops: batch });
  }

  tick(): void {
    const g = this.game;
    if (!g || this.closed) return;
    this.ticks++;
    const p = g.player;
    const b = p.body;
    this.stateOp = ["st", r2(b.x), r2(b.y), r2(b.z), r2(p.yaw), r2(p.pitch), r2(p.walkDist), r2(Math.hypot(b.x - p.prevX, b.z - p.prevZ)),
      r2(g.actions.swingProgress(1)), p.sneaking ? 1 : 0, p.inventory.held?.id ?? -1, g.settings.skin, p.name, p.hurtTime > 0 ? 1 : 0,
      p.dead ? 1 : 0, p.gameMode, p.sleeping ? 1 : 0, p.hasEffect("invisibility") ? 1 : 0, p.riding !== null ? 1 : 0];
    if (this.role === "host") {
      if (this.ticks % ENTITY_TICKS === 0 && g.remote.size) this.push(["en", this.entitySnapshots()]);
      if (this.ticks % ENV_TICKS === 0) this.push(["env", g.time, r2(g.rain), r2(g.thunder), g.meta.difficulty]);
      const now = performance.now();
      for (const [id, r] of g.remote) {
        if (now - r.lastSeen > TIMEOUT_MS) {
          g.remote.delete(id);
          g.message(`${r.name} left the game`, "#ffff55");
          this.updateStatus();
        }
      }
    } else {
      if (this.ticks % PERSIST_TICKS === 0) this.push(["ps", p.toJSON()]);
      if (performance.now() - this.lastHost > TIMEOUT_MS && this.status !== "lost") {
        this.status = "lost";
        this.updateStatus();
        g.onFatal?.("Lost connection to the host. The world stays on the host's side; you can rejoin with the same code.");
      }
    }
    if (this.ticks % FLUSH_TICKS === 0 || this.out.length > 50) this.flush();
  }

  private entitySnapshots(): EntitySnapshot[] {
    const g = this.game!;
    const out: EntitySnapshot[] = [];
    const centres = [...g.remote.values()];
    for (const e of g.entities.values()) {
      if (e.removed) continue;
      if (!centres.some((c) => Math.abs(c.x - e.x) < 96 && Math.abs(c.z - e.z) < 96)) continue;
      out.push(e.snapshot());
      if (out.length >= 300) break;
    }
    return out;
  }

  blockChanged(c: BlockChange): void {
    const key = chunkKey(c.x >> 4, c.z >> 4);
    this.modified.add(key);
    if (this.role === "host") {
      this.seq++;
      this.push(["bl", this.seq, c.x, c.y, c.z, c.id, c.meta]);
    } else if (c.cause === "player") {
      this.push(["ed", c.x, c.y, c.z, c.id, c.meta]);
    }
  }

  chat(text: string): void {
    this.push(["ch", text, this.game?.player.name ?? "?"]);
  }

  // Guest → host actions.
  attack(entityId: number, damage: number, fx: number, fz: number, knockback = 0, fire = 0, looting = 0): void {
    this.push(["at", entityId, r2(damage), r2(fx), r2(fz), r2(knockback), fire, looting]);
  }
  interact(entityId: number, item: string | null): void { this.push(["in", entityId, item]); }
  drops(x: number, y: number, z: number, stacks: ItemStack[], xp: number): void { this.push(["dr", r2(x), r2(y), r2(z), stacks, xp]); }
  throwItem(kind: ProjectileKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, extra: ThrowExtra = {}): void {
    this.push(["th", kind, r2(x), r2(y), r2(z), r3(vx), r3(vy), r3(vz), extra.item ?? 0, r2(extra.damage ?? 0), extra.knockback ?? 0, extra.fire ? 1 : 0]);
  }
  primeTnt(x: number, y: number, z: number, fuse: number): void { this.push(["tn", x, y, z, fuse]); }
  blockEntity(x: number, y: number, z: number, e: BlockEntity | null): void { this.push(["be", x, y, z, e]); }
  sleeping(on: boolean): void { this.push(["sl", on ? 1 : 0]); }

  // Host → guests (and player-versus-player from anyone).
  hurtRemote(id: string, amount: number, source: DamageSource, fx: number, fz: number, kb: number, attacker?: number): void {
    this.push(["hu", id, r2(amount), source, r2(fx), r2(fz), r2(kb), attacker ?? -1]);
  }
  /** A splash potion reached a guest: they own their effects, so the host only tells them. */
  effectRemote(id: string, effect: StatusEffect, seconds: number, amp: number): void { this.push(["ef", id, effect, seconds, amp]); }
  giveRemote(id: string, stack: ItemStack): void { this.push(["gv", id, stack]); }
  advanceRemote(id: string, event: AdvancementEvent): void { this.push(["av", id, event]); }
  pushRemote(id: string, dx: number, dy: number, dz: number): void { this.push(["pu", id, dx, dy, dz]); }
  mount(entityId: number, on: boolean): void { if (this.role === "guest") this.push(["mo", entityId, on ? 1 : 0]); }
  trade(entityId: number, offer: number): void { this.push(["tr", entityId, offer]); }
  vehiclePose(v: Vehicle): void {
    const b = v.body;
    this.push(["vp", v.id, r3(b.x), r3(b.y), r3(b.z), r3(v.yaw), r3(b.vx), r3(b.vy), r3(b.vz)]);
  }
  placeVehicle(kind: string, x: number, y: number, z: number, yaw: number, wood: number): void {
    this.push(["pv", kind, r3(x), r3(y), r3(z), r3(yaw), wood]);
  }
  xpRemote(id: string, amount: number): void { this.push(["xp", id, amount]); }
  effect(kind: "sound" | "particles" | "explosion", data: unknown[]): void {
    if (this.role === "host") this.push(["fx", kind, ...data]);
  }

  isModified(cx: number, cz: number): boolean {
    return this.modified.has(chunkKey(cx, cz));
  }

  requestChunk(cx: number, cz: number): Promise<ChunkData | null> {
    const key = chunkKey(cx, cz);
    const rid = ++this.requestIds;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // The host did not answer: fall back to generating it, and say so once.
        this.chunkRequests.delete(`${rid}`);
        this.game?.message(`The host did not send chunk ${key} in time; showing it as generated.`, "#ffcc55");
        resolve(null);
      }, 10000);
      this.chunkRequests.set(`${rid}`, { resolve, parts: [], received: 0, timer });
      this.send({ t: "creq", to: this.hostId ?? undefined, cx, cz, rid });
    });
  }

  chunkLoaded(cx: number, cz: number, _fromSave: boolean): void {
    const key = chunkKey(cx, cz);
    const ops = this.pendingOps.get(key);
    if (!ops) return;
    this.pendingOps.delete(key);
    const after = this.chunkSeq.get(key) ?? -1;
    this.chunkSeq.delete(key);
    for (const { seq, op } of ops) if (seq > after) this.applyBlock(op);
  }
  private chunkSeq = new Map<string, number>();

  // ---- receiving --------------------------------------------------------------------------------

  private receive(m: NetMessage): void {
    if (this.closed || !m || typeof m.t !== "string" || m.from === this.myId) return;
    if (m.to && m.to !== this.myId) return;
    try {
      switch (m.t) {
        case "hello": if (this.role === "host") void this.onHello(m); break;
        case "welcome": if (this.role === "guest" && this.onWelcome) this.onWelcome(m.w as Welcome); break;
        case "refuse": if (this.onRefused) this.onRefused(String(m.reason)); break;
        case "creq": if (this.role === "host") void this.onChunkRequest(m); break;
        case "chunk": if (this.role === "guest") void this.onChunk(m); break;
        case "bye": this.onBye(m.from); break;
        case "b": this.onBatch(m.from, (m.ops as Op[]) ?? []); break;
      }
    } catch (err) {
      console.warn("[blockcraft] bad message", m.t, err);
    }
  }

  private async onHello(m: NetMessage): Promise<void> {
    const g = this.game;
    if (!g) return;
    if (m.v !== PROTOCOL) {
      this.send({ t: "refuse", to: m.from, reason: "The host is running a different version of BlockCraft. Both players should reload the page." });
      return;
    }
    const name = String(m.name ?? "Player").slice(0, 16) || "Player";
    const pid = typeof m.pid === "string" && m.pid ? m.pid.slice(0, 40) : m.from;
    this.playerIds.set(m.from, pid);
    const saved = g.meta.players[pid] ?? null;
    const w: Welcome = {
      worldName: g.meta.name, seed: g.meta.seed, seedText: g.meta.seedText, type: g.meta.type, time: g.time,
      rain: g.rain, thunder: g.thunder, spawn: g.worldSpawn(), rules: g.meta.rules, difficulty: g.meta.difficulty,
      gameMode: g.meta.gameMode, hardcore: g.meta.hardcore, cheats: g.meta.cheats, modified: [...this.modified], seq: this.seq,
      player: saved, hostId: this.myId, hostName: g.player.name,
    };
    this.send({ t: "welcome", to: m.from, w });
    if (!g.remote.has(m.from)) {
      g.message(`${name} joined the game`, "#ffff55");
      this.push(["ch", `\u0000join:${name} joined the game`, g.player.name]);
      this.names.set(m.from, name);
      const b = w.spawn ?? { x: 0, y: 80, z: 0 };
      this.touchRemote(m.from, { name, x: saved?.x ?? b.x, y: saved?.y ?? b.y, z: saved?.z ?? b.z });
      this.updateStatus();
    }
  }

  private async onChunkRequest(m: NetMessage): Promise<void> {
    const g = this.game;
    if (!g || !int(m.cx) || !int(m.cz)) return;
    const cx = m.cx as number, cz = m.cz as number;
    const data = await g.chunkForGuest(cx, cz);
    // Numbered edits go out ahead of the copy that already contains them, so the guest sees them as included.
    this.flush();
    if (!data) { this.send({ t: "chunk", to: m.from, rid: m.rid, cx, cz, none: true }); return; }
    const { data: bytes, gz } = await packChunk(data);
    const b64 = toBase64(bytes);
    const parts = Math.max(1, Math.ceil(b64.length / MAX_PART));
    for (let i = 0; i < parts; i++) {
      this.send({
        t: "chunk", to: m.from, rid: m.rid, cx, cz, gz, seq: this.seq, part: i, parts,
        data: b64.slice(i * MAX_PART, (i + 1) * MAX_PART), entities: i === 0 ? data.entities : undefined,
      });
    }
  }

  private async onChunk(m: NetMessage): Promise<void> {
    const req = this.chunkRequests.get(`${m.rid}`);
    if (!req) return;
    if (m.none) {
      clearTimeout(req.timer);
      this.chunkRequests.delete(`${m.rid}`);
      req.resolve(null);
      return;
    }
    const parts = Number(m.parts), part = Number(m.part);
    req.parts[part] = String(m.data ?? "");
    req.received++;
    if (part === 0) (req as unknown as { entities: unknown }).entities = m.entities;
    if (req.received < parts) return;
    clearTimeout(req.timer);
    this.chunkRequests.delete(`${m.rid}`);
    try {
      const { blocks, meta } = await unpackChunk(fromBase64(req.parts.join("")), !!m.gz);
      this.chunkSeq.set(chunkKey(m.cx as number, m.cz as number), Number(m.seq));
      req.resolve({ cx: m.cx as number, cz: m.cz as number, blocks, meta, entities: ((req as unknown as { entities?: [number, BlockEntity][] }).entities) ?? [] });
    } catch (err) {
      this.game?.message(`A chunk from the host could not be read (${(err as Error).message}); showing it as generated.`, "#ffcc55");
      req.resolve(null);
    }
  }

  private onBye(from: string): void {
    const g = this.game;
    if (!g) return;
    if (this.role === "guest" && from === this.hostId) {
      this.status = "host left";
      this.updateStatus();
      g.onFatal?.("The host closed the world.");
      return;
    }
    const r = g.remote.get(from);
    if (r) {
      g.remote.delete(from);
      g.message(`${r.name} left the game`, "#ffff55");
      this.updateStatus();
    }
  }

  private touchRemote(id: string, init?: Partial<RemotePlayer>): RemotePlayer {
    const g = this.game!;
    let r = g.remote.get(id);
    const now = performance.now();
    if (!r) {
      r = {
        id, name: this.names.get(id) ?? "Player", x: 0, y: 0, z: 0, yaw: 0, pitch: 0, px: 0, py: 0, pz: 0, pyaw: 0, walk: 0, speed: 0,
        swing: 0, sneaking: false, held: null, variant: 0, hurt: false, dead: false, gameMode: "survival", sleeping: false,
        invisible: false, riding: false, lastSeen: now, receivedAt: 0, ...init,
      };
      r.px = r.x; r.py = r.y; r.pz = r.z;
      g.remote.set(id, r);
      this.updateStatus();
    }
    r.lastSeen = now;
    return r;
  }

  private onBatch(from: string, ops: Op[]): void {
    const g = this.game;
    if (!g) {
      if (this.role === "guest" && this.early.length < 500) this.early.push({ from, ops });
      return;
    }
    const fromHost = from === this.hostId;
    if (this.role === "guest" && fromHost) this.lastHost = performance.now();
    if (this.role === "host") this.touchRemote(from);
    for (const op of ops) {
      if (!Array.isArray(op)) continue;
      const [type] = op;
      switch (type) {
        case "st": this.onState(from, op); break;
        case "ch": {
          const text = String(op[1] ?? "").slice(0, 256);
          if (text.startsWith("\u0000")) {
            // System lines (joins, deaths, advancements): shown as the game's words, not as chat.
            const [kind, msg] = text.slice(1).split(/:(.*)/s);
            if (msg) g.message(msg, kind === "adv" ? "#55ff55" : kind === "death" ? "#ff8888" : "#ffff55");
          } else g.message(`<${String(op[2] ?? "?").slice(0, 16)}> ${text}`);
          break;
        }
        case "bl": if (this.role === "guest" && fromHost) this.onRemoteBlock(op); break;
        case "ed": if (this.role === "host") this.onGuestEdit(from, op); break;
        case "en": if (this.role === "guest" && fromHost) this.onEntities(op[1] as EntitySnapshot[]); break;
        case "env":
          if (this.role === "guest" && fromHost && finite(op[1], op[2], op[3])) {
            const t = op[1] as number;
            if (Math.abs(t - g.time) > 40) g.time = t;
            g.rain = op[2] as number; g.thunder = op[3] as number;
            if (int(op[4])) g.meta.difficulty = op[4] as 0 | 1 | 2 | 3;
            g.audio.setRain(g.rain);
          }
          break;
        case "fx": if (this.role === "guest" && fromHost) this.onEffect(op); break;
        case "hu":
          if (op[1] === this.myId && finite(op[2], op[4], op[5], op[6])) {
            g.hurtLocal(op[2] as number, op[3] as DamageSource, op[4] as number, op[5] as number, op[6] as number, int(op[7]) && (op[7] as number) >= 0 ? (op[7] as number) : undefined);
          }
          break;
        case "ef":
          if (op[1] === this.myId && fromHost && typeof op[2] === "string" && finite(op[3], op[4])) {
            g.player.applyEffect(op[2] as StatusEffect, Math.min(600, op[3] as number), Math.max(0, Math.min(4, op[4] as number)));
          }
          break;
        case "gv":
          if (op[1] === this.myId) {
            const st = sanitizeStack(op[2]);
            if (st) {
              const left = g.player.inventory.add(st);
              if (left > 0) this.drops(g.player.body.x, g.player.body.y + 1, g.player.body.z, [{ ...st, count: left }], 0);
              g.audio.play("pop", null, 0, 0, 0.25, 1.6);
              g.bumpInv();
            }
          }
          break;
        case "xp": if (op[1] === this.myId && finite(op[2])) g.collectXp(op[2] as number); break;
        case "pu":
          // Shoved by a piston on the host.
          if (op[1] === this.myId && fromHost && finite(op[2], op[3], op[4])) {
            const b = g.player.body;
            b.x += Math.max(-1, Math.min(1, op[2] as number)); b.y += Math.max(-1.1, Math.min(1.1, op[3] as number)); b.z += Math.max(-1, Math.min(1, op[4] as number));
          }
          break;
        case "av": {
          const ev = op[2] as AdvancementEvent | null;
          if (op[1] === this.myId && fromHost && ev && (ev.kind === "kill" || ev.kind === "sleep" || ev.kind === "eat")) g.advance(ev);
          break;
        }
        case "be": this.onBlockEntity(from, op); break;
        case "at": if (this.role === "host") this.onAttack(from, op); break;
        case "in": if (this.role === "host") this.onInteract(from, op); break;
        case "dr": if (this.role === "host") this.onDrops(op); break;
        case "th": if (this.role === "host") this.onThrow(from, op); break;
        case "mo": if (this.role === "host") this.onMount(from, op); break;
        case "tr": if (this.role === "host") this.onTrade(from, op); break;
        case "vp": if (this.role === "host") this.onVehiclePose(from, op); break;
        case "pv": if (this.role === "host") this.onPlaceVehicle(from, op); break;
        case "tn": if (this.role === "host" && finite(op[1], op[2], op[3])) g.spawn(new PrimedTnt((op[1] as number) + 0.5, op[2] as number, (op[3] as number) + 0.5, 80)); break;
        case "sl": if (this.role === "host") { const r = g.remote.get(from); if (r) r.sleeping = op[1] === 1; } break;
        case "ps":
          if (this.role === "host" && op[1] && typeof op[1] === "object") {
            g.meta.players[this.playerIds.get(from) ?? from] = { ...(op[1] as PlayerSave), name: g.remote.get(from)?.name ?? "Player" };
          }
          break;
      }
    }
  }

  private onState(from: string, op: Op): void {
    if (!finite(op[1], op[2], op[3], op[4], op[5])) return;
    const r = this.touchRemote(from);
    const now = performance.now();
    const x = op[1] as number, y = op[2] as number, z = op[3] as number;
    if (r.receivedAt === 0) {
      // First state from this player: appear there, rather than gliding in from the spawn guess.
      r.px = x; r.py = y; r.pz = z; r.pyaw = op[4] as number;
    } else {
      // Interpolate from wherever they are drawn right now, so a late packet never makes them jump back.
      const t = Math.min(1, (now - r.receivedAt) / 120);
      r.px += (r.x - r.px) * t; r.py += (r.y - r.py) * t; r.pz += (r.z - r.pz) * t; r.pyaw = r.yaw;
    }
    r.x = x; r.y = y; r.z = z;
    r.yaw = op[4] as number; r.pitch = op[5] as number;
    r.walk = Number(op[6]) || 0; r.speed = Number(op[7]) || 0; r.swing = Number(op[8]) || 0;
    r.sneaking = op[9] === 1;
    r.held = int(op[10]) && (op[10] as number) >= 0 ? (op[10] as number) : null;
    r.variant = int(op[11]) ? (op[11] as number) : 0;
    const name = String(op[12] ?? "").slice(0, 16);
    if (name && name !== r.name) { r.name = name; this.names.set(from, name); this.updateStatus(); }
    r.hurt = op[13] === 1;
    r.dead = op[14] === 1;
    r.gameMode = String(op[15] ?? "survival");
    r.sleeping = op[16] === 1;
    r.invisible = op[17] === 1;
    r.riding = op[18] === 1;
    r.receivedAt = now;
  }

  private onRemoteBlock(op: Op): void {
    const [, seq, x, y, z, id, meta] = op;
    if (!finite(seq, x, y, z, id, meta)) return;
    this.seq = Math.max(this.seq, seq as number);
    const key = chunkKey((x as number) >> 4, (z as number) >> 4);
    this.modified.add(key);
    const g = this.game!;
    if (!g.world.isLoaded(x as number, z as number)) {
      const list = this.pendingOps.get(key) ?? [];
      list.push({ seq: seq as number, op });
      this.pendingOps.set(key, list);
      return;
    }
    this.applyBlock(op);
  }

  private applyBlock(op: Op): void {
    const g = this.game!;
    const [, , x, y, z, id, meta] = op as number[];
    if (!block(id) || y < 0 || y > 127) return;
    const prev = g.world.blockAt(x, y, z);
    if (g.world.setBlock(x, y, z, id, meta, "remote")) this.remoteEditEffects(x, y, z, prev, id);
  }

  private remoteEditEffects(x: number, y: number, z: number, prev: number, id: number): void {
    const g = this.game!;
    const b = g.player.body;
    if (Math.abs(b.x - x) > 24 || Math.abs(b.z - z) > 24) return;
    if (prev && !id) {
      g.audio.block(block(prev).material, "break", x + 0.5, y + 0.5, z + 0.5);
      g.renderer.particles.emit("block", x + 0.5, y + 0.5, z + 0.5, 12, prev);
    } else if (id && !prev) {
      g.audio.block(block(id).material, "place", x + 0.5, y + 0.5, z + 0.5);
    }
  }

  private onGuestEdit(from: string, op: Op): void {
    const g = this.game!;
    const [, x, y, z, id, meta] = op;
    if (!finite(x, y, z, id, meta) || !int(id) || !int(meta) || (y as number) < 0 || (y as number) > 127) return;
    const r = g.remote.get(from);
    // A guest can only edit near where they are standing.
    if (r && (Math.abs(r.x - (x as number)) > 12 || Math.abs(r.z - (z as number)) > 12 || Math.abs(r.y - (y as number)) > 12)) return;
    const prev = g.world.blockAt(x as number, y as number, z as number);
    // setBlock with a non-"remote" cause re-broadcasts it to everyone, stamped.
    if (g.world.setBlock(x as number, y as number, z as number, id as number, meta as number, "player")) {
      this.remoteEditEffects(x as number, y as number, z as number, prev, id as number);
    }
  }

  private onBlockEntity(from: string, op: Op): void {
    const g = this.game!;
    const [, x, y, z, data] = op;
    if (!finite(x, y, z)) return;
    if (this.role === "guest" && from !== this.hostId) return;
    const kind = data && typeof data === "object" ? (data as BlockEntity).kind : undefined;
    const e = kind === "chest" || kind === "furnace" || kind === "brewing" ? (data as BlockEntity) : undefined;
    g.world.setEntity(x as number, y as number, z as number, e);
    if (this.role === "host") this.push(["be", x, y, z, e ?? null]);
    const s = g.screen;
    if (s && (s.kind === "chest" || s.kind === "furnace" || s.kind === "brewing") && s.x === x && s.y === y && s.z === z) g.bumpInv();
  }

  private onEntities(list: EntitySnapshot[]): void {
    const g = this.game!;
    if (!Array.isArray(list)) return;
    const seen = new Set<number>();
    for (const s of list) {
      if (!s || !int(s.id) || !finite(s.x, s.y, s.z)) continue;
      seen.add(s.id);
      let e = g.entities.get(s.id);
      if (!e) {
        const created = entityFromSnapshot(s);
        if (!created) continue;
        e = created;
        g.entities.set(e.id, e);
      } else if (e instanceof Vehicle && g.player.riding === e.id) {
        // This guest drives it: keep its own motion, and only hear who the host says is riding.
        const rider = s.data?.r;
        if (typeof rider === "string" && rider !== g.player.id) g.dismount();
      } else {
        e.beginTick();
        e.applySnapshot(s);
      }
    }
    for (const [id] of g.entities) if (!seen.has(id)) g.entities.delete(id);
  }

  private onEffect(op: Op): void {
    const g = this.game!;
    const [, kind, ...d] = op;
    if (kind === "sound") {
      const [name, x, y, z, v, p] = d as [string, number, number, number, number, number];
      if (typeof name !== "string") return;
      if (name.startsWith("block:")) {
        const [, material, what] = name.split(":");
        g.audio.block(material as never, what as never, x, y, z);
      } else g.audio.play(name, x, y, z, v, p);
    } else if (kind === "particles") {
      const [name, x, y, z, count, data] = d as [string, number, number, number, number, number];
      g.renderer.particles.emit(name, x, y, z, Math.min(64, count), data);
    } else if (kind === "explosion") {
      if (d[0] === "lightning") { g.lightning = 1; return; }
      const [x, y, z] = d as number[];
      g.renderer.particles.emit("explosion", x, y, z, 24);
      g.audio.play("explode", x, y, z, 1, 1);
    }
  }

  private onAttack(from: string, op: Op): void {
    const g = this.game!;
    const [, id, dmg, fx, fz, kb, fire, looting] = op;
    if (!finite(id, dmg, fx, fz)) return;
    const e = g.entities.get(id as number);
    if (e instanceof Vehicle) { e.hurt(g.ctx, Math.min(40, dmg as number), "player", fx as number, fz as number, from); return; }
    if (e instanceof Mob) {
      e.looting = int(looting) ? Math.max(0, Math.min(3, looting as number)) : 0;
      const took = e.hurt(g.ctx, Math.min(40, dmg as number), "player", fx as number, fz as number, from, Math.min(2, Math.max(0, Number(kb) || 0)));
      // Fire Aspect from a guest's sword: the host owns the mob, so it lights it here.
      if (took && finite(fire) && (fire as number) > 0) e.fireTicks = Math.max(e.fireTicks, Math.min(200, fire as number));
    }
  }

  private onInteract(from: string, op: Op): void {
    const g = this.game!;
    const [, id, item] = op;
    const e = g.entities.get(id as number);
    if (e instanceof Mob) e.interact(g.ctx, typeof item === "string" ? item : null, from);
  }

  private onDrops(op: Op): void {
    const g = this.game!;
    const [, x, y, z, stacks, xp] = op;
    if (!finite(x, y, z)) return;
    if (Array.isArray(stacks)) {
      for (const raw of stacks.slice(0, 64)) {
        const s = sanitizeStack(raw);
        if (s) g.dropItem(x as number, y as number, z as number, { ...s, count: Math.min(64, s.count) });
      }
    }
    if (finite(xp) && (xp as number) > 0) g.spawnXp(x as number, y as number, z as number, Math.min(1000, xp as number));
  }

  private onMount(from: string, op: Op): void {
    const [, id, on] = op;
    const v = this.game!.entities.get(id as number);
    if (!(v instanceof Vehicle)) return;
    // First come, first seated; a guest can only climb out of their own seat.
    if (on === 1 && (v.rider === null || v.rider === from)) v.rider = from;
    else if (on === 0 && v.rider === from) v.rider = null;
  }

  private onTrade(from: string, op: Op): void {
    const g = this.game!;
    const [, id, index] = op;
    const v = g.entities.get(id as number);
    const r = g.remote.get(from);
    if (!(v instanceof Mob) || v.kind !== "villager" || !int(index)) return;
    // A trade from a guest the host cannot place is refused, not waved through.
    if (!r || Math.hypot(r.x - v.x, r.z - v.z) > 10) return;
    const offer = v.offers[index as number];
    if (!offer || offer.uses >= offer.maxUses) return;
    if (v.traded(index as number)) g.particles("potion", v.x, v.y + 2.2, v.z, 12, 0x50e050);
  }

  private onVehiclePose(from: string, op: Op): void {
    const [, id, x, y, z, yaw, vx, vy, vz] = op;
    const v = this.game!.entities.get(id as number);
    if (!(v instanceof Vehicle) || v.rider !== from || !finite(x, y, z, yaw, vx, vy, vz)) return;
    const b = v.body;
    // A rider reports where their vehicle went; a jump further than a fast cart could go is not believed.
    if (Math.hypot((x as number) - b.x, (z as number) - b.z) > 4) return;
    b.x = x as number; b.y = y as number; b.z = z as number;
    b.vx = vx as number; b.vy = vy as number; b.vz = vz as number;
    v.yaw = yaw as number;
  }

  private onPlaceVehicle(from: string, op: Op): void {
    const g = this.game!;
    const [, kind, x, y, z, yaw, wood] = op;
    if (!isVehicleKind(kind) || !finite(x, y, z, yaw)) return;
    const r = g.remote.get(from);
    if (r && Math.hypot(r.x - (x as number), r.y - (y as number), r.z - (z as number)) > 8) return;
    g.placeVehicle(kind, x as number, y as number, z as number, yaw as number, int(wood) ? (wood as number) : 0);
  }

  private onThrow(from: string, op: Op): void {
    const g = this.game!;
    const [, kind, x, y, z, vx, vy, vz, item, damage, knockback, fire] = op;
    if (!isProjectileKind(kind) || !finite(x, y, z, vx, vy, vz)) return;
    const p = new Projectile(kind, x as number, y as number, z as number, vx as number, vy as number, vz as number, from);
    if (kind === "potion") {
      if (!int(item) || !itemDef(item as number)) return;
      p.item = item as number;
    }
    // A guest's bow enchantments ride along, bounded so a message cannot forge a one-shot arrow.
    if (kind === "arrow" && finite(damage) && (damage as number) > 0) p.damage = Math.min(6, damage as number);
    if (finite(knockback)) p.knockback = Math.max(0, Math.min(2, knockback as number));
    p.fire = fire === 1;
    g.spawn(p);
  }
}

/** Rebuilds an entity a host described, on a guest. */
/** What travels with a thrown or shot projectile beyond its path: the potion inside, the bow's enchantments. */
export interface ThrowExtra { item?: number; damage?: number; knockback?: number; fire?: boolean }

export function entityFromSnapshot(s: EntitySnapshot): Entity | null {
  let e: Entity | null = null;
  if (isMobKind(s.kind)) e = new Mob(s.kind, s.x, s.y, s.z, s.id);
  else if (s.kind === "item") {
    const st = sanitizeStack(s.data?.stack);
    if (st) e = new ItemEntity(s.x, s.y, s.z, st, 0, s.id);
  } else if (s.kind === "xp") e = new XpOrb(s.x, s.y, s.z, Number(s.data?.value ?? 1), s.id);
  else if (isProjectileKind(s.kind)) e = new Projectile(s.kind, s.x, s.y, s.z, s.vx ?? 0, s.vy ?? 0, s.vz ?? 0, null, s.id);
  else if (isVehicleKind(s.kind)) e = vehicleFromSnapshot(s);
  else if (s.kind === "falling_block") e = new FallingBlock(s.x, s.y, s.z, Number(s.data?.b ?? 12), Number(s.data?.m ?? 0), s.id);
  else if (s.kind === "tnt") e = new PrimedTnt(s.x, s.y, s.z, Number(s.data?.fuse ?? 80), s.id);
  if (e) {
    e.applySnapshot(s);
    e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
  }
  return e;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

