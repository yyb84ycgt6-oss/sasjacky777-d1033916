/**
 * What the player does to the world: look, aim, mine, place, use, attack,
 * eat, draw a bow, drop things, sleep.
 *
 * Mining time is the original's formula — tool speed against block hardness,
 * divided by 30 when the tool can harvest the block and 100 when it cannot,
 * slowed five-fold underwater or in mid-air — so a player's sense of "stone
 * pickaxe on iron is about a second" holds. Placement respects what each
 * block needs: torches want a wall or floor, crops want farmland, doors want
 * two blocks of room, a slab on a slab makes a double slab.
 */
import * as THREE from "three";
import {
  B, block, CLOCKWISE_FACING, collisionBoxes, Face, FACING_DIRS, isCrop, isFluid, isLeaves, isLog, isSlab, isStairs, OPPOSITE_FACING,
  type BlockDef,
} from "../engine/blocks";
import { cropDrops, supported } from "../engine/blockRules";
import { PrimedTnt, Projectile } from "../engine/entities";
import { itemDef, itemId, resolveDrops, type ItemDef, type ItemStack } from "../engine/items";
import { Mob } from "../engine/mobs";
import { aabbIntersects, bodyBox } from "../engine/physics";
import { raycastBlocks, rayBox, type BlockHit } from "../engine/raycast";
import { WORLD_HEIGHT } from "../engine/constants";
import type { Entity } from "../engine/entities";
import type { Game, RemotePlayer } from "./game";

export interface Target {
  block: BlockHit | null;
  entity: Entity | null;
  remote: RemotePlayer | null;
}

const FACE_NORMALS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const SHEARABLE = new Set<number>([B.OAK_LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.JUNGLE_LEAVES, B.ACACIA_LEAVES, B.SHORT_GRASS, B.FERN, B.DEAD_BUSH, B.COBWEB]);

/** Ticks to break a block with a held item; 0 is instant, Infinity never. */
export function breakTicks(def: BlockDef, held: ItemDef | undefined, inWater: boolean, onGround: boolean): { ticks: number; harvest: boolean } {
  if (def.hardness < 0) return { ticks: Infinity, harvest: false };
  const tool = held?.tool;
  const harvest = def.harvestTier === undefined || (!!tool && tool.type === def.tool && tool.tier >= def.harvestTier);
  if (def.hardness === 0) return { ticks: 0, harvest };
  let speed = 1;
  if (tool && tool.type === def.tool) speed = tool.speed;
  if (tool?.type === "sword" && def.id === B.COBWEB) speed = 15;
  if (tool?.type === "shears") {
    if (isLeaves(def.id) || def.id === B.COBWEB) speed = 15;
    else if (def.material === "wool") speed = 5;
  }
  if (tool?.type === "sword" && (isLeaves(def.id) || def.material === "plant")) speed = 1.5;
  if (inWater) speed /= 5;
  if (!onGround) speed /= 5;
  const perTick = speed / def.hardness / (harvest ? 30 : 100);
  if (perTick >= 1) return { ticks: 0, harvest };
  return { ticks: Math.ceil(1 / perTick), harvest };
}

/** Horizontal facing (0 north, 1 south, 2 west, 3 east) the player is looking along. */
export function lookFacing(yaw: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  if (Math.abs(fx) > Math.abs(fz)) return fx > 0 ? 3 : 2;
  return fz > 0 ? 1 : 0;
}

function facingOfNormal(face: number): number {
  switch (face) {
    case Face.North: return 0;
    case Face.South: return 1;
    case Face.West: return 2;
    case Face.East: return 3;
    default: return -1;
  }
}

export class Actions {
  target: Target | null = null;
  private mining: { x: number; y: number; z: number; progress: number; ticks: number } | null = null;
  private swingTick = -1;
  private swingPrev = -1;
  private equip = 0;
  private equipTarget: number | null = null;
  private useCooldown = 0;
  private attackPrev = false;
  private usePrev = false;
  private creativeCooldown = 0;
  private eating: { ticks: number; slot: number; id: number } | null = null;
  private bow: { ticks: number } | null = null;
  private dir = new THREE.Vector3();

  constructor(private game: Game) {}

  // ---- per frame -----------------------------------------------------------------------

  frameInput(_dt: number): void {
    const g = this.game;
    const c = g.controls;
    const p = g.player;
    const blocked = !!g.screen;
    if (!blocked && !p.dead) {
      if (p.sleeping && (c.jump || c.sneak || c.forward !== 0)) this.wakeUp();
      p.yaw -= c.lookX;
      p.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, p.pitch - c.lookY));
    }
    c.lookX = 0;
    c.lookY = 0;
    for (const a of c.actions.splice(0)) this.handle(a);
  }

  private handle(a: import("./types").GameAction): void {
    const g = this.game;
    const p = g.player;
    const inv = p.inventory;
    if (a.type === "close" || a.type === "pause") {
      // Escape backs out of whatever is open; the death screen stays until a choice is made.
      if (g.screen && g.screen.kind !== "death") { g.setScreen(null); return; }
      if (a.type === "pause" && !g.screen) g.setScreen({ kind: "pause" });
      return;
    }
    if (a.type === "chat") { if (!g.screen) g.setScreen({ kind: "chat", text: a.text ?? "" }); return; }
    if (a.type === "inventory") {
      if (g.screen?.kind === "inventory" || g.screen?.kind === "crafting" || g.screen?.kind === "furnace" || g.screen?.kind === "chest") g.setScreen(null);
      else if (!g.screen && !p.dead && p.gameMode !== "spectator") g.setScreen({ kind: "inventory" });
      return;
    }
    if (g.screen) return;
    switch (a.type) {
      case "hotbar":
        inv.selected = Math.max(0, Math.min(8, a.slot));
        this.stopUsing();
        g.bumpInv();
        break;
      case "scroll":
        inv.selected = (((inv.selected + Math.sign(a.delta)) % 9) + 9) % 9;
        this.stopUsing();
        g.bumpInv();
        break;
      case "drop": this.dropHeld(a.all); break;
      case "pickBlock": this.pickBlock(); break;
      case "perspective": g.perspective = ((g.perspective + 1) % 3) as 0 | 1 | 2; break;
      case "debug": g.debug = !g.debug; break;
      case "hideHud": g.hudHidden = !g.hudHidden; break;
      case "toggleFly":
        if (p.canFly && p.gameMode !== "spectator") p.flying = !p.flying;
        break;
      case "screenshot": {
        const url = g.renderer.screenshot();
        const a2 = document.createElement("a");
        a2.href = url;
        a2.download = `blockcraft-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        a2.click();
        g.message("Saved screenshot", "#aaffaa");
        break;
      }
    }
  }

  /** Recomputes what the crosshair (or the finger) is on. */
  updateTarget(): void {
    const g = this.game;
    const p = g.player;
    if (p.dead || g.screen || p.sleeping) { this.target = null; return; }
    const b = p.body;
    const ox = b.x, oy = b.y + b.eyeHeight, oz = b.z;
    const aim = g.controls.aim;
    if (aim) {
      const cam = g.renderer.camera;
      this.dir.set(aim.x, aim.y, 0.5).unproject(cam).sub(cam.position).normalize();
    } else {
      this.dir.set(-Math.sin(p.yaw) * Math.cos(p.pitch), Math.sin(p.pitch), -Math.cos(p.yaw) * Math.cos(p.pitch));
    }
    const d = this.dir;
    const reach = p.gameMode === "creative" ? 5 : 4.5;
    const entityReach = p.gameMode === "creative" ? 5 : 3;
    const hit = p.gameMode === "spectator" ? null : raycastBlocks(g.world, ox, oy, oz, d.x, d.y, d.z, reach);
    let best: Entity | null = null, bestT = Math.min(entityReach, hit ? hit.distance : Infinity);
    for (const e of g.entities.values()) {
      if (!(e instanceof Mob) || e.dying) continue;
      if (Math.abs(e.x - ox) > 6 || Math.abs(e.z - oz) > 6) continue;
      const box = e.box();
      const r = rayBox(ox, oy, oz, d.x, d.y, d.z, { ...box, minX: box.minX - 0.1, maxX: box.maxX + 0.1, minZ: box.minZ - 0.1, maxZ: box.maxZ + 0.1 }, bestT);
      if (r && r.t < bestT) { bestT = r.t; best = e; }
    }
    let remote: RemotePlayer | null = null;
    for (const r of g.remote.values()) {
      if (r.dead) continue;
      const h = r.sneaking ? 1.5 : 1.8;
      const res = rayBox(ox, oy, oz, d.x, d.y, d.z, { minX: r.x - 0.35, minY: r.y, minZ: r.z - 0.35, maxX: r.x + 0.35, maxY: r.y + h, maxZ: r.z + 0.35 }, bestT);
      if (res && res.t < bestT) { bestT = res.t; remote = r; best = null; }
    }
    this.target = { block: best || remote ? null : hit, entity: best, remote };
  }

  // ---- per tick --------------------------------------------------------------------------

  tick(): void {
    const g = this.game;
    const p = g.player;
    const c = g.controls;
    if (this.swingTick >= 0) { this.swingPrev = this.swingTick; this.swingTick++; if (this.swingTick > 6) { this.swingTick = -1; this.swingPrev = -1; } }
    else this.swingPrev = -1;
    if (this.useCooldown > 0) this.useCooldown--;
    if (this.creativeCooldown > 0) this.creativeCooldown--;

    // The held item dips and rises when it changes.
    const heldId = p.inventory.held?.id ?? null;
    if (heldId !== this.equipTarget) { this.equip = Math.min(1, this.equip + 0.4); if (this.equip >= 1) this.equipTarget = heldId; }
    else this.equip = Math.max(0, this.equip - 0.25);

    const active = !g.screen && !p.dead && !p.sleeping;
    const attack = active && c.attack;
    const use = active && c.use;

    // Attack.
    if (attack && p.gameMode !== "spectator") {
      const t = this.target;
      if (t?.entity || t?.remote) {
        if (!this.attackPrev || p.attackStrength() >= 1) this.attackTarget(t);
        this.mining = null;
      } else if (t?.block) {
        this.mine(t.block);
      } else {
        if (!this.attackPrev) this.swing();
        this.mining = null;
      }
    } else this.mining = null;
    this.attackPrev = attack;

    // Use.
    if (this.eating) {
      if (!use || p.inventory.selected !== this.eating.slot || p.inventory.held?.id !== this.eating.id) this.eating = null;
      else this.eatTick();
    } else if (this.bow) {
      if (!use) this.releaseBow();
      else this.bow.ticks++;
    } else if (use && p.gameMode !== "spectator") {
      if (!this.usePrev || this.useCooldown === 0) {
        this.use(!this.usePrev);
        this.useCooldown = 4;
      }
    }
    this.usePrev = use;
  }

  swing(): void {
    this.swingTick = 0;
    this.swingPrev = 0;
  }

  swingProgress(alpha: number): number {
    if (this.swingTick < 0) return 0;
    return Math.min(1, (this.swingPrev + (this.swingTick - this.swingPrev) * alpha) / 6);
  }

  equipOffset(): number {
    return this.equip;
  }

  crackStage(): number {
    if (!this.mining || this.game.player.gameMode === "creative") return -1;
    return Math.floor(this.mining.progress * 10) - 1;
  }

  breakProgress(): number {
    return this.mining?.progress ?? 0;
  }

  eatingPhase(): number {
    return this.eating ? this.eating.ticks / 20 : 0;
  }

  bowPull(): number {
    if (!this.bow) return 0;
    return Math.min(1, this.bow.ticks / 20);
  }

  bowFov(): number {
    const pull = this.bowPull();
    return 1 - pull * pull * 0.15;
  }

  stopUsing(): void {
    this.eating = null;
    this.bow = null;
    this.mining = null;
  }

  /** Mobile auto-jump: a one-block step straight ahead while walking gets a jump. */
  autoJumpNow(): boolean {
    const g = this.game;
    if (!g.settings.autoJump || !g.isMobile) return false;
    const p = g.player, b = p.body;
    if (!b.onGround || g.controls.forward <= 0.3 || p.flying) return false;
    const ahead = 0.6;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const x = Math.floor(b.x + fx * ahead), z = Math.floor(b.z + fz * ahead), y = Math.floor(b.y + 0.01);
    const front = block(g.world.blockAt(x, y, z));
    if (!front.solid || isFluid(front.id)) return false;
    const boxes = collisionBoxes(front, g.world.getMeta(x, y, z));
    const top = Math.max(0, ...boxes.map((bx) => bx[4])) / 16;
    if (top <= 0.6) return false; // a step handles it
    return !block(g.world.blockAt(x, y + 1, z)).solid && !block(g.world.blockAt(x, y + 2, z)).solid;
  }

  // ---- mining ------------------------------------------------------------------------------

  private mine(hit: BlockHit): void {
    const g = this.game;
    const p = g.player;
    if (p.gameMode === "adventure") return;
    const { x, y, z } = hit;
    const id = g.world.blockAt(x, y, z);
    if (!id) { this.mining = null; return; }
    const def = block(id);
    this.swing();
    if (p.gameMode === "creative") {
      const held = p.inventory.held ? itemDef(p.inventory.held.id) : undefined;
      // Swords cannot break blocks in creative, as in the original.
      if (held?.tool?.type === "sword" || this.creativeCooldown > 0) return;
      this.breakBlock(x, y, z, false);
      this.creativeCooldown = 5;
      return;
    }
    if (!this.mining || this.mining.x !== x || this.mining.y !== y || this.mining.z !== z) {
      this.mining = { x, y, z, progress: 0, ticks: 0 };
    }
    const held = p.inventory.held ? itemDef(p.inventory.held.id) : undefined;
    const { ticks } = breakTicks(def, held, p.body.eyesInWater, p.body.onGround || p.flying);
    if (ticks === Infinity) return;
    const m = this.mining;
    m.ticks++;
    m.progress = ticks === 0 ? 1 : Math.min(1, m.progress + 1 / ticks);
    if (m.ticks % 4 === 1) {
      g.blockSound(def.material, "dig", x + 0.5, y + 0.5, z + 0.5, false);
      g.particles("block", hit.px, hit.py, hit.pz, 2, id, false);
    }
    if (m.progress >= 1) {
      this.breakBlock(x, y, z, true);
      this.mining = null;
      this.useCooldown = Math.max(this.useCooldown, 0);
    }
  }

  /** Breaks a block as the player, dropping what the held tool earns. */
  breakBlock(x: number, y: number, z: number, drops: boolean): void {
    const g = this.game;
    const p = g.player;
    const id = g.world.blockAt(x, y, z);
    const meta = g.world.getMeta(x, y, z);
    if (!id) return;
    const def = block(id);
    const held = p.inventory.held ? itemDef(p.inventory.held.id) : undefined;
    const { harvest } = breakTicks(def, held, false, true);

    let stacks: ItemStack[] = [];
    if (drops && harvest) {
      if (held?.tool?.type === "shears" && SHEARABLE.has(id)) stacks = [{ id, count: 1 }];
      else if (isCrop(id)) stacks = cropDrops(id, meta, Math.random);
      else if (id === B.OAK_DOOR && meta & 8) stacks = [];
      else if (id === B.RED_BED && meta & 4) stacks = [];
      else if (isSlab(id) && meta === 2) stacks = [{ id, count: 2 }];
      else stacks = resolveDrops(def.drops, id, Math.random);
    }
    if (drops) g.dropContainerContents(x, y, z);
    else g.world.setEntity(x, y, z, undefined);

    // Two-block things come down together.
    if (id === B.OAK_DOOR) {
      const other = meta & 8 ? y - 1 : y + 1;
      if (g.world.blockAt(x, other, z) === B.OAK_DOOR) g.world.setBlock(x, other, z, B.AIR, 0, "player");
      if (meta & 8 && drops && harvest) stacks = [{ id: itemId("oak_door"), count: 1 }];
    }
    if (id === B.RED_BED) {
      const [dx, dz] = FACING_DIRS[meta & 3];
      const head = (meta & 4) !== 0;
      const ox = head ? x - dx : x + dx, oz = head ? z - dz : z + dz;
      if (g.world.blockAt(ox, y, oz) === B.RED_BED) g.world.setBlock(ox, y, oz, B.AIR, 0, "player");
      if (head && drops) stacks = [{ id: itemId("red_bed"), count: 1 }];
    }
    // Ice over something turns to water, as it melts in your hands.
    const replacement = id === B.ICE && drops && block(g.world.blockAt(x, y - 1, z)).solid ? B.WATER : B.AIR;
    g.world.setBlock(x, y, z, replacement, 0, "player");
    // Not broadcast: everyone else plays these from the block change itself, and would hear it twice.
    g.blockSound(def.material, "break", x + 0.5, y + 0.5, z + 0.5, false);
    g.particles("block", x + 0.5, y + 0.5, z + 0.5, 16, id, false);

    for (const s of stacks) g.dropItem(x + 0.5, y + 0.3, z + 0.5, s);
    if (drops && harvest && def.xp) {
      const [lo, hi] = def.xp;
      g.spawnXp(x + 0.5, y + 0.5, z + 0.5, lo + Math.floor(Math.random() * (hi - lo + 1)));
    }
    if (p.survivalLike) {
      p.addExhaustion(0.005);
      if (held?.durability && def.hardness > 0) this.wearHeld(held.tool?.type === "sword" ? 2 : 1);
    }
  }

  private wearHeld(amount: number): void {
    const g = this.game;
    if (!g.player.survivalLike) return;
    if (g.player.inventory.damageHeld(amount)) {
      g.sound("break_tool", null, 0, 0, 0.8);
      g.audio.block("wood", "break", g.player.body.x, g.player.body.y, g.player.body.z);
      g.showActionbar("Your tool broke");
    }
    g.bumpInv();
  }

  // ---- combat ------------------------------------------------------------------------------

  private attackTarget(t: Target): void {
    const g = this.game;
    const p = g.player;
    const held = p.inventory.held ? itemDef(p.inventory.held.id) : undefined;
    const strength = p.attackStrength();
    let damage = (held?.damage ?? 1) * (0.2 + strength * strength * 0.8);
    const crit = strength > 0.9 && p.body.fallDistance > 0 && !p.body.onGround && !p.body.inWater && !p.body.onLadder;
    if (crit) damage *= 1.5;
    this.swing();
    p.attackTicks = 0;
    p.addExhaustion(0.1);
    const b = p.body;
    if (t.entity) {
      const e = t.entity;
      if (crit) g.particles("crit", e.x, e.y + e.body.height * 0.7, e.z, 10);
      if (g.role === "guest") g.net?.attack(e.id, damage, b.x, b.z);
      else if (e instanceof Mob) e.hurt(g.ctx, damage, "player", b.x, b.z, p.id);
      g.sound("hit", e.x, e.y + 1, e.z, 0.5);
    } else if (t.remote) {
      g.net?.hurtRemote(t.remote.id, damage, "player", b.x, b.z, 0.4);
      if (crit) g.particles("crit", t.remote.x, t.remote.y + 1.2, t.remote.z, 10);
    }
    if (held?.durability && held.tool) this.wearHeld(held.tool.type === "sword" ? 1 : 2);
    if (p.sprinting) p.sprinting = false;
  }

  // ---- using -----------------------------------------------------------------------------------

  private use(fresh: boolean): void {
    const g = this.game;
    const p = g.player;
    const inv = p.inventory;
    const held = inv.held;
    const def = held ? itemDef(held.id) : undefined;
    const t = this.target;

    if (t?.entity instanceof Mob && fresh) {
      const name = def?.name ?? null;
      if (g.role === "guest") {
        g.net?.interact(t.entity.id, name);
        if (name === "bucket" && t.entity.kind === "cow") this.replaceHeld({ id: itemId("milk_bucket"), count: 1 });
        else if (name && t.entity.spec.tempt.includes(name)) this.consumeHeld();
        this.swing();
        return;
      }
      const result = t.entity.interact(g.ctx, name, p.id);
      if (result) {
        this.swing();
        if (result === "fed" || result === "dyed") this.consumeHeld();
        if (result === "sheared") this.wearHeld(1);
        if (result === "milked") this.replaceHeld({ id: itemId("milk_bucket"), count: 1 });
        if (result === "fed") g.particles("heart", t.entity.x, t.entity.y + t.entity.body.height, t.entity.z, 3);
        return;
      }
    }

    if (t?.block) {
      if (this.useOnBlock(t.block, def, fresh)) return;
    } else if (def && fresh) {
      // Buckets aim at fluid surfaces, which the ordinary ray passes through.
      if (def.use === "bucket") { this.fillBucket(); return; }
      if (def.use === "water_bucket" || def.use === "lava_bucket") { this.emptyBucketAtFluid(def); return; }
    }
    if (!def || !fresh) return;
    this.useInAir(def);
  }

  private useInAir(def: ItemDef): void {
    const g = this.game;
    const p = g.player;
    if (def.food) {
      if (p.canEat(def.food)) this.eating = { ticks: 0, slot: p.inventory.selected, id: def.id };
      return;
    }
    if (def.use === "milk_bucket") {
      this.eating = { ticks: 0, slot: p.inventory.selected, id: def.id };
      return;
    }
    if (def.use === "bow") {
      if (!p.survivalLike || p.inventory.count(itemId("arrow")) > 0) this.bow = { ticks: 0 };
      return;
    }
    if (def.use === "throw") {
      const kind = def.name === "egg" ? "egg" : "snowball";
      this.throwProjectile(kind, 1.5);
      if (p.survivalLike) this.consumeHeld();
      g.sound("bow", p.body.x, p.body.y + 1.5, p.body.z, 0.4, 0.6);
      this.swing();
      return;
    }
    if (def.armor) {
      const slot = def.armor.slot;
      const inv = p.inventory;
      const prev = inv.armor[slot];
      inv.armor[slot] = inv.held;
      inv.slots[inv.selected] = prev;
      g.sound("click", null, 0, 0, 0.4);
      g.bumpInv();
      return;
    }
  }

  private throwProjectile(kind: "arrow" | "snowball" | "egg", speed: number, pull = 1): void {
    const g = this.game;
    const p = g.player;
    const d = this.dir;
    const b = p.body;
    const x = b.x + d.x * 0.3, y = b.y + b.eyeHeight - 0.1, z = b.z + d.z * 0.3;
    const spread = 0.0075 * (1 - pull * 0.5);
    const vx = (d.x + (Math.random() - 0.5) * spread) * speed + b.vx;
    const vy = (d.y + (Math.random() - 0.5) * spread) * speed + (b.onGround ? 0 : b.vy);
    const vz = (d.z + (Math.random() - 0.5) * spread) * speed + b.vz;
    if (g.role === "guest") { g.net?.throwItem(kind, x, y, z, vx, vy, vz); return; }
    const proj = new Projectile(kind, x, y, z, vx, vy, vz, p.id);
    if (kind === "arrow") {
      proj.damage = 2 + (pull >= 1 && Math.random() < 0.25 ? 1 : 0);
      proj.pickup = p.gameMode !== "creative";
    }
    g.spawn(proj);
  }

  private releaseBow(): void {
    const g = this.game;
    const p = g.player;
    const ticks = this.bow?.ticks ?? 0;
    this.bow = null;
    let f = ticks / 20;
    f = (f * f + f * 2) / 3;
    if (f < 0.1) return;
    f = Math.min(1, f);
    this.throwProjectile("arrow", f * 3, f);
    g.sound("bow", p.body.x, p.body.y + 1.5, p.body.z, 0.8, 1 / (Math.random() * 0.4 + 1.2) + f * 0.5);
    if (p.survivalLike) {
      p.inventory.remove(itemId("arrow"), 1);
      this.wearHeld(1);
    }
    this.swing();
  }

  private eatTick(): void {
    const g = this.game;
    const p = g.player;
    const e = this.eating!;
    e.ticks++;
    const b = p.body;
    if (e.ticks % 4 === 0 && e.ticks < 32) {
      g.sound("eat", b.x, b.y + 1.4, b.z, 0.5, 0.8 + Math.random() * 0.4);
      const d = this.dir;
      g.particles("block", b.x + d.x * 0.5, b.y + b.eyeHeight - 0.2, b.z + d.z * 0.5, 2, 0, false);
    }
    if (e.ticks < 32) return;
    this.eating = null;
    const held = p.inventory.held;
    if (!held) return;
    const def = itemDef(held.id);
    if (def?.use === "milk_bucket") {
      p.effects = [];
      if (p.survivalLike) this.replaceHeld({ id: itemId("bucket"), count: 1 });
      return;
    }
    p.eat(held, Math.random);
    if (p.survivalLike) {
      const remainder = def?.food?.remainder;
      if (remainder) this.replaceHeld({ id: itemId(remainder), count: 1 });
      else this.consumeHeld();
    }
    g.bumpInv();
  }

  private consumeHeld(n = 1): void {
    const g = this.game;
    if (!g.player.survivalLike) return;
    g.player.inventory.consumeHeld(n);
    g.bumpInv();
  }

  /** Swaps the held item for another (full bucket for empty), keeping the rest of a stack. */
  private replaceHeld(stack: ItemStack): void {
    const g = this.game;
    const inv = g.player.inventory;
    const held = inv.held;
    if (!g.player.survivalLike && !(itemDef(stack.id)?.name === "milk_bucket")) return;
    if (held && held.count > 1) {
      held.count--;
      const left = inv.add(stack);
      if (left > 0) this.throwStack({ ...stack, count: left });
    } else inv.slots[inv.selected] = stack;
    g.bumpInv();
  }

  // ---- blocks: interaction and placement ------------------------------------------------------

  /** Returns true when the click did something. */
  private useOnBlock(hit: BlockHit, def: ItemDef | undefined, fresh: boolean): boolean {
    const g = this.game;
    const p = g.player;
    const w = g.world;
    const { x, y, z } = hit;
    const id = w.blockAt(x, y, z);
    const bdef = block(id);
    const meta = w.getMeta(x, y, z);

    if ((!p.sneaking || !def) && fresh && bdef.interact) {
      if (this.interactBlock(x, y, z, id, meta, def)) return true;
    }
    if (!def) return false;
    if (p.gameMode === "adventure") return false;

    // Tools used on blocks.
    if (fresh) {
      if (def.use === "hoe" && (id === B.GRASS || id === B.DIRT || id === B.DIRT_PATH || id === B.COARSE_DIRT) && hit.face !== Face.Down && w.blockAt(x, y + 1, z) === 0) {
        w.setBlock(x, y, z, id === B.COARSE_DIRT ? B.DIRT : B.FARMLAND, 0, "player");
        g.blockSound("dirt", "place", x + 0.5, y + 1, z + 0.5);
        this.swing();
        this.wearHeld(1);
        return true;
      }
      if (def.tool?.type === "shovel" && id === B.GRASS && hit.face !== Face.Down && w.blockAt(x, y + 1, z) === 0) {
        w.setBlock(x, y, z, B.DIRT_PATH, 0, "player");
        g.blockSound("grass", "place", x + 0.5, y + 1, z + 0.5);
        this.swing();
        this.wearHeld(1);
        return true;
      }
      if (def.use === "shears" && id === B.PUMPKIN) {
        w.setBlock(x, y, z, B.CARVED_PUMPKIN, lookFacing(p.yaw) ^ 1, "player");
        g.sound("shear", x + 0.5, y + 0.5, z + 0.5);
        this.swing();
        this.wearHeld(1);
        return true;
      }
      if (def.use === "bone_meal") {
        if (g.role === "guest") return false;
        if (g.rules.boneMeal(x, y, z)) {
          g.particles("heart", x + 0.5, y + 1, z + 0.5, 0);
          g.particles("crit", x + 0.5, y + 0.8, z + 0.5, 8);
          this.consumeHeld();
          this.swing();
          return true;
        }
      }
      if (def.use === "flint_and_steel") {
        if (id === B.TNT) {
          w.setBlock(x, y, z, B.AIR, 0, "player");
          if (g.role === "guest") g.net?.primeTnt(x, y, z, 80);
          else g.spawn(new PrimedTnt(x + 0.5, y, z + 0.5, 80));
          g.sound("fuse", x + 0.5, y + 0.5, z + 0.5);
          this.wearHeld(1);
          this.swing();
          return true;
        }
        g.sound("ignite", x + 0.5, y + 0.5, z + 0.5);
        this.wearHeld(1);
        this.swing();
        return true;
      }
      if (def.use === "bucket") return this.fillBucket();
      if (def.use === "water_bucket" || def.use === "lava_bucket") return this.emptyBucket(hit, def);
    }

    if (def.places !== undefined) return this.place(hit, def);
    return false;
  }

  private interactBlock(x: number, y: number, z: number, id: number, meta: number, held: ItemDef | undefined): boolean {
    const g = this.game;
    const w = g.world;
    switch (block(id).interact) {
      case "crafting":
        g.setScreen({ kind: "crafting", x, y, z });
        return true;
      case "furnace":
        g.containerAt(x, y, z, "furnace");
        g.setScreen({ kind: "furnace", x, y, z });
        return true;
      case "chest":
        g.containerAt(x, y, z, "chest");
        g.sound("chest_open", x + 0.5, y + 0.5, z + 0.5, 0.5);
        g.setScreen({ kind: "chest", x, y, z });
        return true;
      case "door": {
        const lowerY = meta & 8 ? y - 1 : y;
        const lower = w.getMeta(x, lowerY, z);
        const open = (lower & 4) === 0;
        const nl = open ? lower | 4 : lower & ~4;
        w.setBlock(x, lowerY, z, B.OAK_DOOR, nl, "player");
        if (w.blockAt(x, lowerY + 1, z) === B.OAK_DOOR) w.setBlock(x, lowerY + 1, z, B.OAK_DOOR, nl | 8, "player");
        g.sound(open ? "door_open" : "door_close", x + 0.5, y + 0.5, z + 0.5, 0.8);
        this.swing();
        return true;
      }
      case "bed":
        this.trySleep(x, y, z, meta);
        return true;
      case "tnt":
        // Lit with flint and steel, handled as an item use below.
        void held;
        return false;
      case "noteblock": {
        const pitch = (meta + 1) % 25;
        w.setBlock(x, y, z, id, pitch, "player");
        g.sound("note", x + 0.5, y + 0.5, z + 0.5, 1, 0.5 + pitch / 24 * 1.5);
        g.particles("note", x + 0.5, y + 1.2, z + 0.5, 1);
        this.swing();
        return true;
      }
    }
    return false;
  }

  private trySleep(x: number, y: number, z: number, meta: number): void {
    const g = this.game;
    const p = g.player;
    const [dx, dz] = FACING_DIRS[meta & 3];
    const hx = meta & 4 ? x : x + dx, hz = meta & 4 ? z : z + dz;
    if (!g.isNight() && g.thunder < 0.5) {
      p.spawn = { x: hx, y, z: hz };
      g.showActionbar("Respawn point set — you can only sleep at night or during thunderstorms");
      return;
    }
    const b = p.body;
    if (Math.hypot(b.x - (hx + 0.5), b.z - (hz + 0.5)) > 3) { g.showActionbar("You may not rest now; the bed is too far away"); return; }
    for (const e of g.entities.values()) {
      if (e instanceof Mob && e.spec.hostile && Math.abs(e.x - b.x) < 8 && Math.abs(e.y - b.y) < 5 && Math.abs(e.z - b.z) < 8) {
        g.showActionbar("You may not rest now; there are monsters nearby");
        return;
      }
    }
    p.spawn = { x: hx, y, z: hz };
    p.sleeping = { x: hx, y, z: hz };
    p.sleepTicks = 0;
    b.x = hx + 0.5; b.z = hz + 0.5; b.y = y + 0.6;
    b.vx = b.vy = b.vz = 0;
    g.showActionbar("Respawn point set");
    g.net?.sleeping(true);
  }

  wakeUp(): void {
    const g = this.game;
    const p = g.player;
    if (!p.sleeping) return;
    const s = p.sleeping;
    p.sleeping = null;
    p.sleepTicks = 0;
    p.body.y = s.y + 0.6;
    g.net?.sleeping(false);
  }

  private collidesWithEntity(x: number, y: number, z: number, id: number, meta: number): boolean {
    const g = this.game;
    const boxes = collisionBoxes(block(id), meta);
    if (!boxes.length) return false;
    const bodies = [g.player.body, ...[...g.entities.values()].filter((e) => e instanceof Mob).map((e) => e.body)];
    for (const bx of boxes) {
      const box = { minX: x + bx[0] / 16, minY: y + bx[1] / 16, minZ: z + bx[2] / 16, maxX: x + bx[3] / 16, maxY: y + bx[4] / 16, maxZ: z + bx[5] / 16 };
      for (const b of bodies) {
        if (b === g.player.body && g.player.gameMode === "spectator") continue;
        if (aabbIntersects(box, bodyBox(b))) return true;
      }
      for (const r of g.remote.values()) {
        if (!r.dead && aabbIntersects(box, { minX: r.x - 0.3, minY: r.y, minZ: r.z - 0.3, maxX: r.x + 0.3, maxY: r.y + 1.8, maxZ: r.z + 0.3 })) return true;
      }
    }
    return false;
  }

  private place(hit: BlockHit, item: ItemDef): boolean {
    const g = this.game;
    const p = g.player;
    const w = g.world;
    const id = item.places!;
    const def = block(id);
    const clicked = w.blockAt(hit.x, hit.y, hit.z);
    const clickedMeta = w.getMeta(hit.x, hit.y, hit.z);
    const n = FACE_NORMALS[hit.face];
    const fracY = hit.py - Math.floor(hit.py);

    // A bottom slab clicked on its top (or a top slab from below) becomes a double slab in place.
    if (isSlab(id) && clicked === id && clickedMeta !== 2 && ((clickedMeta === 0 && hit.face === Face.Up) || (clickedMeta === 1 && hit.face === Face.Down))) {
      return this.commit(hit.x, hit.y, hit.z, id, 2, item);
    }

    let x = hit.x, y = hit.y, z = hit.z;
    const replaceTarget = block(clicked).replaceable && clicked !== B.WATER && clicked !== B.LAVA && clicked !== id;
    if (!replaceTarget) { x += n[0]; y += n[1]; z += n[2]; }
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const cur = w.getBlock(x, y, z);
    if (cur < 0) return false;
    const curDef = block(cur);
    // Placing into water: only where the new block can hold it back.
    if (!(cur === 0 || curDef.replaceable)) {
      if (isSlab(id) && cur === id && w.getMeta(x, y, z) !== 2) return this.commit(x, y, z, id, 2, item);
      return false;
    }

    let meta = 0;
    const look = lookFacing(p.yaw);
    if (def.facing === "player") meta = OPPOSITE_FACING[look];
    else if (def.facing === "away") {
      meta = look;
      if (isStairs(id) && (hit.face === Face.Down || (hit.face !== Face.Up && fracY > 0.5))) meta |= 4;
    }
    if (isLog(id)) {
      meta = hit.face === Face.Up || hit.face === Face.Down ? 0 : hit.face === Face.East || hit.face === Face.West ? 1 : 2;
    }
    if (isSlab(id)) meta = hit.face === Face.Down || (hit.face !== Face.Up && fracY > 0.5) ? 1 : 0;
    if (id === B.TORCH) {
      if (hit.face === Face.Down) return false;
      if (hit.face === Face.Up) meta = 0;
      else meta = 1 + facingOfNormal(hit.face);
      if (!supported(w, x, y, z, id, meta)) {
        // Fall back to standing on the floor if the wall cannot hold it.
        if (supported(w, x, y, z, id, 0)) meta = 0;
        else return false;
      }
    }
    if (id === B.LADDER) {
      if (hit.face === Face.Up || hit.face === Face.Down) return false;
      meta = OPPOSITE_FACING[facingOfNormal(hit.face)];
    }
    if (isLeaves(id)) meta = 1; // placed leaves never decay

    // Crops go on farmland; lily pads on water.
    if (item.use === "plant" && (isCrop(id))) {
      if (w.blockAt(x, y - 1, z) !== B.FARMLAND) return false;
    }
    if (id === B.LILY_PAD) {
      const fluid = this.fluidHit();
      if (!fluid || w.blockAt(fluid.x, fluid.y, fluid.z) !== B.WATER) return false;
      x = fluid.x; y = fluid.y + 1; z = fluid.z;
      if (w.blockAt(x, y, z) !== 0) return false;
    }
    if (def.needsSupport && id !== B.TORCH && id !== B.LADDER && id !== B.OAK_DOOR && id !== B.RED_BED && !supported(w, x, y, z, id, meta)) return false;

    if (id === B.OAK_DOOR) {
      if (!block(w.blockAt(x, y - 1, z)).opaque) return false;
      const above = w.getBlock(x, y + 1, z);
      if (above < 0 || !(above === 0 || block(above).replaceable)) return false;
      const facing = look;
      // Hinge on the side away from a neighbouring door, so double doors open outward.
      const [lx, lz] = FACING_DIRS[CLOCKWISE_FACING[CLOCKWISE_FACING[CLOCKWISE_FACING[facing]]]];
      const hinge = w.blockAt(x + lx, y, z + lz) === B.OAK_DOOR ? 16 : 0;
      if (this.collidesWithEntity(x, y, z, id, facing) || this.collidesWithEntity(x, y + 1, z, id, facing | 8)) return false;
      w.setBlock(x, y, z, B.OAK_DOOR, facing | hinge, "player");
      w.setBlock(x, y + 1, z, B.OAK_DOOR, facing | 8 | hinge, "player");
      return this.afterPlace(x, y, z, def, item);
    }
    if (id === B.RED_BED) {
      const facing = look;
      const [dx, dz] = FACING_DIRS[facing];
      const hx = x + dx, hz = z + dz;
      const headCur = w.getBlock(hx, y, hz);
      if (headCur < 0 || !(headCur === 0 || block(headCur).replaceable)) return false;
      if (!block(w.blockAt(x, y - 1, z)).solid || !block(w.blockAt(hx, y - 1, hz)).solid) return false;
      w.setBlock(x, y, z, B.RED_BED, facing, "player");
      w.setBlock(hx, y, hz, B.RED_BED, facing | 4, "player");
      return this.afterPlace(x, y, z, def, item);
    }
    if (this.collidesWithEntity(x, y, z, id, meta)) return false;
    return this.commit(x, y, z, id, meta, item);
  }

  private commit(x: number, y: number, z: number, id: number, meta: number, item: ItemDef): boolean {
    const g = this.game;
    if (!g.world.setBlock(x, y, z, id, meta, "player")) return false;
    const def = block(id);
    if (def.interact === "chest") g.containerAt(x, y, z, "chest");
    if (def.interact === "furnace") g.containerAt(x, y, z, "furnace");
    return this.afterPlace(x, y, z, def, item);
  }

  private afterPlace(x: number, y: number, z: number, def: BlockDef, _item: ItemDef): boolean {
    const g = this.game;
    g.blockSound(def.material, "place", x + 0.5, y + 0.5, z + 0.5, false);
    this.swing();
    this.consumeHeld();
    return true;
  }

  private fluidHit(): BlockHit | null {
    const g = this.game;
    const p = g.player;
    const b = p.body;
    const d = this.dir;
    return raycastBlocks(g.world, b.x, b.y + b.eyeHeight, b.z, d.x, d.y, d.z, 5, true);
  }

  private fillBucket(): boolean {
    const g = this.game;
    const hit = this.fluidHit();
    if (!hit) return false;
    const id = g.world.blockAt(hit.x, hit.y, hit.z);
    if (!isFluid(id) || (g.world.getMeta(hit.x, hit.y, hit.z) & 15) !== 0) return false;
    g.world.setBlock(hit.x, hit.y, hit.z, B.AIR, 0, "player");
    g.sound("bucket_fill", hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    const full = { id: itemId(id === B.WATER ? "water_bucket" : "lava_bucket"), count: 1 };
    if (g.player.survivalLike) this.replaceHeld(full);
    this.swing();
    return true;
  }

  private emptyBucket(hit: BlockHit, def: ItemDef): boolean {
    const g = this.game;
    const n = FACE_NORMALS[hit.face];
    const clicked = g.world.blockAt(hit.x, hit.y, hit.z);
    let x = hit.x, y = hit.y, z = hit.z;
    if (!block(clicked).replaceable) { x += n[0]; y += n[1]; z += n[2]; }
    const cur = g.world.getBlock(x, y, z);
    if (cur < 0 || !(cur === 0 || block(cur).replaceable || isFluid(cur))) return false;
    const fluid = def.use === "water_bucket" ? B.WATER : B.LAVA;
    g.world.setBlock(x, y, z, fluid, 0, "player");
    g.sound("bucket_empty", x + 0.5, y + 0.5, z + 0.5);
    if (g.player.survivalLike) this.replaceHeld({ id: itemId("bucket"), count: 1 });
    this.swing();
    return true;
  }

  private emptyBucketAtFluid(def: ItemDef): boolean {
    const hit = this.fluidHit();
    return hit ? this.emptyBucket(hit, def) : false;
  }

  // ---- items ---------------------------------------------------------------------------------

  /** Throws a stack out in front of the player. */
  throwStack(stack: ItemStack): void {
    const g = this.game;
    const p = g.player;
    const b = p.body;
    const d = this.dir.lengthSq() > 0 ? this.dir : new THREE.Vector3(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    g.dropItem(b.x, b.y + b.eyeHeight - 0.3, b.z, stack, d.x * 0.3, d.y * 0.3 + 0.1, d.z * 0.3, p.id, 40);
  }

  private dropHeld(all: boolean): void {
    const g = this.game;
    const p = g.player;
    const held = p.inventory.held;
    if (!held || p.dead) return;
    const n = all ? held.count : 1;
    this.throwStack({ ...held, count: n });
    held.count -= n;
    if (held.count <= 0) p.inventory.slots[p.inventory.selected] = null;
    this.swing();
    g.bumpInv();
  }

  private pickBlock(): void {
    const g = this.game;
    const t = this.target?.block;
    if (!t) return;
    const inv = g.player.inventory;
    let id = g.world.blockAt(t.x, t.y, t.z);
    if (id === B.LIT_FURNACE) id = B.FURNACE;
    if (id === B.OAK_DOOR) id = itemId("oak_door");
    if (id === B.RED_BED) id = itemId("red_bed");
    if (id === B.WHEAT) id = itemId("wheat_seeds");
    if (id === B.CARROTS) id = itemId("carrot");
    if (id === B.POTATOES) id = itemId("potato");
    if (!itemDef(id)) return;
    const inHotbar = inv.slots.findIndex((s, i) => i < 9 && s?.id === id);
    if (inHotbar >= 0) { inv.selected = inHotbar; g.bumpInv(); return; }
    if (g.player.gameMode === "creative") {
      const empty = inv.slots.findIndex((s, i) => i < 9 && !s);
      const slot = empty >= 0 ? empty : inv.selected;
      inv.slots[slot] = { id, count: 1 };
      inv.selected = slot;
      g.bumpInv();
      return;
    }
    const elsewhere = inv.slots.findIndex((s, i) => i >= 9 && s?.id === id);
    if (elsewhere >= 0) {
      const tmp = inv.slots[inv.selected];
      inv.slots[inv.selected] = inv.slots[elsewhere];
      inv.slots[elsewhere] = tmp;
      g.bumpInv();
    }
  }
}

