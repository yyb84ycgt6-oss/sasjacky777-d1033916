/**
 * Everything in the world that is not a block: dropped items, experience
 * orbs, arrows and thrown things, falling sand, lit TNT — and, in mobs.ts,
 * the animals and monsters.
 *
 * Entities only touch the game through `EntityContext`, which is how the same
 * code runs for a single-player world and for the host of an online one: the
 * context decides whether "damage this player" means changing a local health
 * bar or sending a message to someone else's browser.
 */
import { block, B } from "./blocks";
import { sameItem } from "./inventory";
import { maxStack, type ItemStack } from "./items";
import { bodyBox, moveBody, newBody, senseEnvironment, type AABB, type Body } from "./physics";
import { raycastBlocks, rayBox } from "./raycast";
import type { World } from "./world";

export type EntityKind =
  | "item" | "xp" | "arrow" | "snowball" | "egg" | "potion" | "xp_bottle" | "falling_block" | "tnt"
  | "pig" | "cow" | "sheep" | "chicken" | "zombie" | "skeleton" | "creeper" | "spider" | "slime" | "villager" | "iron_golem"
  | "boat" | "minecart" | "tnt_minecart";

export interface PlayerRef {
  id: string;
  name: string;
  x: number; y: number; z: number;
  width: number; height: number;
  /** Players in creative or spectator are ignored by monsters. */
  targetable: boolean;
  /** Item the player is holding (tempts animals). */
  heldItem: number;
  sneaking: boolean;
  /** Under an invisibility potion: monsters notice them only up close. */
  invisible?: boolean;
}

export type DamageSource = "mob" | "arrow" | "explosion" | "fall" | "fire" | "lava" | "drown" | "starve" | "void" | "cactus" | "player" | "magic" | "suffocation";

export interface EntityContext {
  world: World;
  tick: number;
  /** Sky brightness, 0 (night) .. 1 (noon). */
  daylight: number;
  difficulty: 0 | 1 | 2 | 3;
  random: () => number;
  players(): PlayerRef[];
  /** `attacker` is the mob's entity id, when a mob struck (so Thorns can strike back). */
  hurtPlayer(id: string, amount: number, source: DamageSource, fromX: number, fromZ: number, knockback: number, attacker?: number): void;
  /** Tries to hand a stack to a player; returns how many they could not take. */
  givePlayer(id: string, stack: ItemStack): number;
  giveXp(id: string, amount: number): void;
  spawn(e: Entity): void;
  dropItem(x: number, y: number, z: number, stack: ItemStack, vx?: number, vy?: number, vz?: number): void;
  explode(x: number, y: number, z: number, power: number, cause: Entity | null): void;
  sound(name: string, x: number, y: number, z: number, volume?: number, pitch?: number): void;
  particles(kind: string, x: number, y: number, z: number, count?: number, data?: number): void;
  entitiesNear(x: number, y: number, z: number, radius: number): Entity[];
  /** Places a block as the world (sand landing), returning whether it took. */
  placeBlock(x: number, y: number, z: number, id: number, meta: number): boolean;
  /** A player's blow finished a mob off (for advancements). */
  creditKill?(playerId: string, hostile: boolean): void;
  /** A thrown potion burst here; `direct` is what it struck, which takes the full dose. */
  splashPotion?(itemId: number, x: number, y: number, z: number, direct: Entity | PlayerRef | null, owner: string | null): void;
}

let nextEntityId = 1;
export function allocateEntityId(): number {
  return nextEntityId++;
}
export function bumpEntityIds(past: number): void {
  if (past >= nextEntityId) nextEntityId = past + 1;
}

/** State shipped to other players and saved to disk. */
export interface EntitySnapshot {
  id: number;
  kind: EntityKind;
  x: number; y: number; z: number;
  vx?: number; vy?: number; vz?: number;
  yaw: number;
  pitch?: number;
  health?: number;
  /** Kind-specific fields. */
  data?: Record<string, unknown>;
}

export abstract class Entity {
  readonly id: number;
  abstract readonly kind: EntityKind;
  body: Body;
  yaw = 0;
  pitch = 0;
  /** Where the entity was last tick, for smooth rendering between ticks. */
  prevX: number; prevY: number; prevZ: number; prevYaw = 0;
  age = 0;
  removed = false;
  fireTicks = 0;
  /** Distance walked, drives the leg swing in the renderer. */
  walkDist = 0;
  prevWalkDist = 0;

  constructor(x: number, y: number, z: number, width: number, height: number, id = allocateEntityId()) {
    this.id = id;
    this.body = newBody(x, y, z, width, height, height * 0.85);
    this.prevX = x; this.prevY = y; this.prevZ = z;
  }

  get x(): number { return this.body.x; }
  get y(): number { return this.body.y; }
  get z(): number { return this.body.z; }

  box(): AABB {
    return bodyBox(this.body);
  }

  beginTick(): void {
    this.prevX = this.body.x; this.prevY = this.body.y; this.prevZ = this.body.z;
    this.prevYaw = this.yaw;
    this.prevWalkDist = this.walkDist;
    this.age++;
  }

  abstract tick(ctx: EntityContext): void;

  /** Hit by a player or mob; `knockback` adds to the usual shove (Knockback, Punch). Returns true if it took the hit. */
  hurt(_ctx: EntityContext, _amount: number, _source: DamageSource, _fromX: number, _fromZ: number, _attackerId?: string, _knockback = 0): boolean {
    return false;
  }

  snapshot(): EntitySnapshot {
    return { id: this.id, kind: this.kind, x: round(this.body.x), y: round(this.body.y), z: round(this.body.z), vx: round(this.body.vx), vy: round(this.body.vy), vz: round(this.body.vz), yaw: round(this.yaw) };
  }

  applySnapshot(s: EntitySnapshot): void {
    this.body.x = s.x; this.body.y = s.y; this.body.z = s.z;
    this.body.vx = s.vx ?? 0; this.body.vy = s.vy ?? 0; this.body.vz = s.vz ?? 0;
    this.yaw = s.yaw;
    if (s.pitch !== undefined) this.pitch = s.pitch;
  }

  /** Simple gravity-and-drag motion shared by items, orbs and falling blocks. */
  protected fall(ctx: EntityContext, gravity: number, drag: number): void {
    const b = this.body;
    senseEnvironment(ctx.world, b);
    if (b.inWater) {
      b.vy += 0.005; // bob up in water
      b.vx *= 0.9; b.vz *= 0.9; b.vy *= 0.9;
    } else {
      b.vy -= gravity;
    }
    moveBody(ctx.world, b, b.vx, b.vy, b.vz);
    b.vx *= drag; b.vy *= 0.98; b.vz *= drag;
    if (b.onGround) { b.vx *= 0.6; b.vz *= 0.6; }
  }
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---- dropped items -----------------------------------------------------------------

export class ItemEntity extends Entity {
  readonly kind = "item" as const;
  pickupDelay: number;
  bob: number;
  /** Player who threw it; they cannot pick it straight back up. */
  thrower: string | null = null;

  constructor(x: number, y: number, z: number, public stack: ItemStack, pickupDelay = 10, id?: number) {
    super(x, y, z, 0.25, 0.25, id);
    this.pickupDelay = pickupDelay;
    this.bob = Math.random() * Math.PI * 2;
  }

  tick(ctx: EntityContext): void {
    if (this.pickupDelay > 0) this.pickupDelay--;
    this.fall(ctx, 0.04, 0.98);
    if (this.body.inLava || this.fireTicks > 0 && this.age % 10 === 0) {
      this.removed = true;
      ctx.particles("smoke", this.x, this.y + 0.2, this.z, 4);
      ctx.sound("fizz", this.x, this.y, this.z, 0.4);
      return;
    }
    if (this.age > 6000) { this.removed = true; return; }
    // Merge with a nearby identical stack, so a mined vein is one pile, not forty.
    if (this.age % 10 === 0) {
      for (const e of ctx.entitiesNear(this.x, this.y, this.z, 0.8)) {
        // Two swords are two swords: only stacks that could share a slot merge.
        if (e !== this && e instanceof ItemEntity && !e.removed && sameItem(e.stack, this.stack) && e.stack.count + this.stack.count <= maxStack(this.stack.id)) {
          this.stack.count += e.stack.count;
          e.removed = true;
        }
      }
    }
    if (this.pickupDelay > 0) return;
    for (const p of ctx.players()) {
      if (p.id === this.thrower && this.age < 40) continue;
      const dx = p.x - this.x, dy = p.y + 0.5 - this.y, dz = p.z - this.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1.4) {
        const left = ctx.givePlayer(p.id, { ...this.stack });
        if (left < this.stack.count) {
          ctx.sound("pop", this.x, this.y, this.z, 0.25, 1.4 + ctx.random() * 0.6);
          if (left <= 0) { this.removed = true; return; }
          this.stack.count = left;
        }
      } else if (d < 2.2) {
        // A gentle pull the last metre, which reads as "picked up" rather than "touched".
        this.body.vx += (dx / d) * 0.03; this.body.vz += (dz / d) * 0.03; this.body.vy += (dy / d) * 0.02;
      }
    }
  }

  snapshot(): EntitySnapshot {
    return { ...super.snapshot(), data: { stack: this.stack, delay: this.pickupDelay } };
  }
  applySnapshot(s: EntitySnapshot): void {
    super.applySnapshot(s);
    const st = s.data?.stack as ItemStack | undefined;
    if (st) this.stack = st;
  }
}

// ---- experience -----------------------------------------------------------------------

export class XpOrb extends Entity {
  readonly kind = "xp" as const;
  constructor(x: number, y: number, z: number, public value: number, id?: number) {
    super(x, y, z, 0.25, 0.25, id);
    this.body.vx = (Math.random() - 0.5) * 0.2;
    this.body.vy = Math.random() * 0.2;
    this.body.vz = (Math.random() - 0.5) * 0.2;
  }
  tick(ctx: EntityContext): void {
    this.fall(ctx, 0.03, 0.98);
    if (this.age > 6000) { this.removed = true; return; }
    let best: PlayerRef | null = null, bestD = 8;
    for (const p of ctx.players()) {
      const d = Math.hypot(p.x - this.x, p.y + 0.9 - this.y, p.z - this.z);
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) return;
    if (bestD < 1) {
      ctx.giveXp(best.id, this.value);
      ctx.sound("orb", this.x, this.y, this.z, 0.2, 0.8 + ctx.random() * 0.8);
      this.removed = true;
      return;
    }
    const pull = (1 - bestD / 8) ** 2 * 0.1;
    this.body.vx += ((best.x - this.x) / bestD) * pull;
    this.body.vy += ((best.y + 0.9 - this.y) / bestD) * pull;
    this.body.vz += ((best.z - this.z) / bestD) * pull;
  }
  snapshot(): EntitySnapshot {
    return { ...super.snapshot(), data: { value: this.value } };
  }
}

/** Splits an XP amount into orbs the way the original does (bigger orbs for bigger rewards). */
export function xpOrbValues(total: number): number[] {
  const sizes = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];
  const out: number[] = [];
  let left = Math.floor(total);
  while (left > 0) {
    const s = sizes.find((v) => v <= left) ?? 1;
    out.push(s);
    left -= s;
  }
  return out;
}

// ---- projectiles -----------------------------------------------------------------------

export type ProjectileKind = "arrow" | "snowball" | "egg" | "potion" | "xp_bottle";
export const isProjectileKind = (k: unknown): k is ProjectileKind =>
  k === "arrow" || k === "snowball" || k === "egg" || k === "potion" || k === "xp_bottle";

export class Projectile extends Entity {
  inGround = false;
  groundTicks = 0;
  /** Who fired it: a player id, a mob entity id, or null. */
  owner: string | null;
  /** Players may pick up arrows they shot; skeleton arrows only break. */
  pickup: boolean;
  damage: number;
  /** Punch: extra knockback on a hit. */
  knockback = 0;
  /** Flame: sets what it hits alight. */
  fire = false;
  /** The potion a thrown bottle holds (item id). */
  item = 0;

  constructor(public readonly kind: ProjectileKind, x: number, y: number, z: number, vx: number, vy: number, vz: number, owner: string | null, id?: number) {
    super(x, y, z, 0.25, 0.25, id);
    this.body.vx = vx; this.body.vy = vy; this.body.vz = vz;
    this.owner = owner;
    this.pickup = kind === "arrow" && owner !== null && !owner.startsWith("mob:");
    this.damage = kind === "arrow" ? 2 : 0;
    this.faceVelocity();
  }

  private faceVelocity(): void {
    const b = this.body;
    this.yaw = Math.atan2(b.vx, b.vz);
    this.pitch = Math.atan2(b.vy, Math.hypot(b.vx, b.vz));
  }

  tick(ctx: EntityContext): void {
    const b = this.body;
    if (this.inGround) {
      this.groundTicks++;
      if (this.groundTicks > 1200) this.removed = true;
      // The block it stuck in was mined: fall out.
      if (ctx.world.blockAt(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z)) === 0) this.inGround = false;
      if (this.pickup && this.groundTicks > 5) {
        for (const p of ctx.players()) {
          if (Math.hypot(p.x - b.x, p.y + 0.5 - b.y, p.z - b.z) < 1.2) {
            if (ctx.givePlayer(p.id, { id: ARROW_ITEM(), count: 1 }) === 0) {
              ctx.sound("pop", b.x, b.y, b.z, 0.25, 1.6);
              this.removed = true;
            }
          }
        }
      }
      return;
    }
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    // Entities along this tick's path.
    let hitEntity: Entity | null = null, hitPlayer: PlayerRef | null = null, best = 1;
    for (const e of ctx.entitiesNear(b.x, b.y, b.z, speed + 2)) {
      if (e === this || e.kind === "item" || e.kind === "xp" || e instanceof Projectile || `mob:${e.id}` === this.owner) continue;
      if (this.age < 3 && e.kind === "tnt") continue;
      const box = e.box();
      const r = rayBox(b.x, b.y, b.z, b.vx, b.vy, b.vz, grow(box, 0.3), 1);
      if (r && r.t < best) { best = r.t; hitEntity = e; hitPlayer = null; }
    }
    for (const p of ctx.players()) {
      if (p.id === this.owner && this.age < 5) continue;
      const box: AABB = { minX: p.x - p.width / 2, minY: p.y, minZ: p.z - p.width / 2, maxX: p.x + p.width / 2, maxY: p.y + p.height, maxZ: p.z + p.width / 2 };
      const r = rayBox(b.x, b.y, b.z, b.vx, b.vy, b.vz, grow(box, 0.3), 1);
      if (r && r.t < best) { best = r.t; hitPlayer = p; hitEntity = null; }
    }
    const blockHit = raycastBlocks(ctx.world, b.x, b.y, b.z, b.vx, b.vy, b.vz, speed);
    const blockT = blockHit ? blockHit.distance / Math.max(speed, 1e-6) : 2;
    if ((hitEntity || hitPlayer) && best < blockT) {
      const dmg = this.kind === "arrow" ? Math.ceil(speed * this.damage) : this.kind === "snowball" ? 0 : 0;
      const nx = b.vx / (speed || 1), nz = b.vz / (speed || 1);
      // A bottle bursts on whatever it meets; only arrows and snowballs strike.
      if (this.kind !== "potion" && this.kind !== "xp_bottle") {
        if (hitEntity) {
          if (hitEntity.hurt(ctx, Math.max(dmg, 0.001), this.kind === "arrow" ? "arrow" : "player", b.x - nx, b.z - nz, this.owner ?? undefined, this.knockback * 0.5) && this.fire) {
            hitEntity.fireTicks = Math.max(hitEntity.fireTicks, 100);
          }
        }
        if (hitPlayer && dmg > 0) ctx.hurtPlayer(hitPlayer.id, dmg, "arrow", b.x - nx, b.z - nz, 0.4 + this.knockback * 0.5);
      }
      this.impact(ctx, hitEntity ?? hitPlayer);
      return;
    }
    if (blockHit) {
      b.x = blockHit.px - b.vx / speed * 0.05; b.y = blockHit.py - b.vy / speed * 0.05; b.z = blockHit.pz - b.vz / speed * 0.05;
      if (this.kind === "arrow") {
        this.inGround = true;
        b.vx = b.vy = b.vz = 0;
        ctx.sound("arrow_hit", b.x, b.y, b.z, 0.6);
        if (ctx.world.blockAt(blockHit.x, blockHit.y, blockHit.z) === B.TNT) {
          ctx.world.setBlock(blockHit.x, blockHit.y, blockHit.z, B.AIR);
          ctx.spawn(new PrimedTnt(blockHit.x + 0.5, blockHit.y, blockHit.z + 0.5, 80));
        }
      } else this.impact(ctx);
      return;
    }
    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    senseEnvironment(ctx.world, b);
    const drag = b.inWater ? 0.6 : 0.99;
    b.vx *= drag; b.vy = b.vy * drag - (this.kind === "arrow" ? 0.05 : 0.03); b.vz *= drag;
    this.faceVelocity();
    if (this.age > 1200 || b.y < -64) this.removed = true;
  }

  private impact(ctx: EntityContext, struck: Entity | PlayerRef | null = null): void {
    this.removed = true;
    const b = this.body;
    if (this.kind === "potion") ctx.splashPotion?.(this.item, b.x, b.y, b.z, struck, this.owner);
    if (this.kind === "xp_bottle") {
      ctx.sound("glass_break", b.x, b.y, b.z, 0.8);
      ctx.particles("splash", b.x, b.y, b.z, 12);
      // Three to eleven points, as the original's bottle o' enchanting.
      for (const v of xpOrbValues(3 + Math.floor(ctx.random() * 5) + Math.floor(ctx.random() * 5))) ctx.spawn(new XpOrb(b.x, b.y, b.z, v));
    }
    if (this.kind === "snowball") ctx.particles("snow", b.x, b.y, b.z, 8);
    if (this.kind === "egg") {
      ctx.particles("egg", b.x, b.y, b.z, 8);
      if (ctx.random() < 0.125 && spawnChicken) {
        const chick = spawnChicken(b.x, b.y, b.z, true);
        if (chick) ctx.spawn(chick);
      }
    }
    if (this.kind === "arrow") ctx.sound("arrow_hit", b.x, b.y, b.z, 0.6);
  }

  snapshot(): EntitySnapshot {
    return { ...super.snapshot(), pitch: round(this.pitch), data: { k: this.kind, g: this.inGround, i: this.item || undefined, f: this.fire ? 1 : undefined } };
  }
  applySnapshot(s: EntitySnapshot): void {
    super.applySnapshot(s);
    this.inGround = !!s.data?.g;
    if (typeof s.data?.i === "number") this.item = s.data.i;
    this.fire = s.data?.f === 1;
  }
}

/** Set by mobs.ts, so an egg can hatch without entities.ts importing the mob module. */
export let spawnChicken: ((x: number, y: number, z: number, baby: boolean) => Entity | null) | null = null;
export function registerChickenSpawner(fn: (x: number, y: number, z: number, baby: boolean) => Entity | null): void {
  spawnChicken = fn;
}
let arrowItemId = -1;
export function registerArrowItem(id: number): void {
  arrowItemId = id;
}
const ARROW_ITEM = () => arrowItemId;

function grow(b: AABB, by: number): AABB {
  return { minX: b.minX - by, minY: b.minY - by, minZ: b.minZ - by, maxX: b.maxX + by, maxY: b.maxY + by, maxZ: b.maxZ + by };
}

// ---- falling blocks and TNT --------------------------------------------------------------

export class FallingBlock extends Entity {
  readonly kind = "falling_block" as const;
  constructor(x: number, y: number, z: number, public blockId: number, public meta = 0, id?: number) {
    super(x, y, z, 0.98, 0.98, id);
  }
  tick(ctx: EntityContext): void {
    const b = this.body;
    b.vy -= 0.04;
    moveBody(ctx.world, b, 0, b.vy, 0);
    b.vy *= 0.98;
    if (b.onGround || this.age > 600) {
      this.removed = true;
      const x = Math.floor(b.x), y = Math.floor(b.y + 0.5), z = Math.floor(b.z);
      const here = ctx.world.blockAt(x, y, z);
      if ((here === 0 || block(here).replaceable) && ctx.placeBlock(x, y, z, this.blockId, this.meta)) return;
      ctx.dropItem(b.x, b.y + 0.5, b.z, { id: this.blockId, count: 1 });
    }
    // Landing on someone hurts, a little.
    for (const p of ctx.players()) {
      if (Math.abs(p.x - b.x) < 0.8 && Math.abs(p.z - b.z) < 0.8 && b.y > p.y + 1.2 && b.y < p.y + p.height + 0.3 && b.vy < -0.3) {
        ctx.hurtPlayer(p.id, 2, "suffocation", b.x, b.z, 0);
      }
    }
  }
  snapshot(): EntitySnapshot {
    return { ...super.snapshot(), data: { b: this.blockId, m: this.meta } };
  }
}

export class PrimedTnt extends Entity {
  readonly kind = "tnt" as const;
  constructor(x: number, y: number, z: number, public fuse = 80, id?: number) {
    super(x, y, z, 0.98, 0.98, id);
    const a = Math.random() * Math.PI * 2;
    this.body.vx = -Math.sin(a) * 0.02;
    this.body.vy = 0.2;
    this.body.vz = -Math.cos(a) * 0.02;
  }
  tick(ctx: EntityContext): void {
    this.fall(ctx, 0.04, 0.98);
    this.fuse--;
    if (this.age % 3 === 0) ctx.particles("smoke", this.x, this.y + 1, this.z, 1);
    if (this.fuse <= 0) {
      this.removed = true;
      ctx.explode(this.x, this.y + 0.49, this.z, 4, this);
    }
  }
  snapshot(): EntitySnapshot {
    return { ...super.snapshot(), data: { fuse: this.fuse } };
  }
  applySnapshot(s: EntitySnapshot): void {
    super.applySnapshot(s);
    if (typeof s.data?.fuse === "number") this.fuse = s.data.fuse;
  }
}
