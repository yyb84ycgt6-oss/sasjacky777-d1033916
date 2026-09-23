/**
 * Animals and monsters.
 *
 * Behaviour is a short priority list per mob rather than a general planner:
 * panic beats breeding beats following food beats wandering, and for monsters
 * attacking beats wandering. That is roughly how the original's goal
 * selectors resolve, and it keeps each mob's behaviour readable in one place.
 *
 * Numbers — health, speed, damage, the creeper's 1.5 second fuse, a zombie's
 * reach — follow the original so fights play out as expected.
 */
import { B, block, WOOL_COLORS } from "./blocks";
import {
  Entity, Projectile, registerChickenSpawner, XpOrb, xpOrbValues,
  type DamageSource, type EntityContext, type EntityKind, type EntitySnapshot, type PlayerRef,
} from "./entities";
import { itemByName, type ItemStack, type StatusEffect } from "./items";
import { travel } from "./physics";
import { raycastBlocks } from "./raycast";
import { hashFloat } from "./rng";

export type MobKind = "pig" | "cow" | "sheep" | "chicken" | "zombie" | "skeleton" | "creeper" | "spider" | "slime";

interface MobSpec {
  health: number;
  width: number;
  height: number;
  /** Acceleration fed to travel(); see physics.ts. */
  speed: number;
  hostile: boolean;
  /** Melee damage on normal difficulty. */
  attack: number;
  tempt: string[];
  burnsInDay: boolean;
  followRange: number;
  xp: [number, number];
}

export const MOB_SPECS: Record<MobKind, MobSpec> = {
  pig: { health: 10, width: 0.9, height: 0.9, speed: 0.0625, hostile: false, attack: 0, tempt: ["carrot", "potato"], burnsInDay: false, followRange: 10, xp: [1, 3] },
  cow: { health: 10, width: 0.9, height: 1.4, speed: 0.05, hostile: false, attack: 0, tempt: ["wheat"], burnsInDay: false, followRange: 10, xp: [1, 3] },
  sheep: { health: 8, width: 0.9, height: 1.3, speed: 0.055, hostile: false, attack: 0, tempt: ["wheat"], burnsInDay: false, followRange: 10, xp: [1, 3] },
  chicken: { health: 4, width: 0.4, height: 0.7, speed: 0.0625, hostile: false, attack: 0, tempt: ["wheat_seeds"], burnsInDay: false, followRange: 10, xp: [1, 3] },
  zombie: { health: 20, width: 0.6, height: 1.95, speed: 0.058, hostile: true, attack: 3, tempt: [], burnsInDay: true, followRange: 35, xp: [5, 5] },
  skeleton: { health: 20, width: 0.6, height: 1.99, speed: 0.0625, hostile: true, attack: 2, tempt: [], burnsInDay: true, followRange: 16, xp: [5, 5] },
  creeper: { health: 20, width: 0.6, height: 1.7, speed: 0.0625, hostile: true, attack: 0, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
  spider: { health: 16, width: 1.4, height: 0.9, speed: 0.09, hostile: true, attack: 2, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
  // Width, height and health are per unit of size; see Mob.setSize.
  slime: { health: 1, width: 0.52, height: 0.52, speed: 0.1, hostile: true, attack: 0, tempt: [], burnsInDay: false, followRange: 16, xp: [1, 1] },
};

export const MOB_KINDS = Object.keys(MOB_SPECS) as MobKind[];

/** Undead take Smite's extra damage, are hurt by healing and healed by harming, and shrug off poison. */
const UNDEAD = new Set<string>(["zombie", "skeleton"]);
/** Arthropods take Bane of Arthropods' extra damage. */
const ARTHROPODS = new Set<string>(["spider"]);
export const isUndead = (kind: string): boolean => UNDEAD.has(kind);
export const isArthropod = (kind: string): boolean => ARTHROPODS.has(kind);

interface MobEffect { kind: StatusEffect; ticks: number; amp: number }
export const isMobKind = (k: string): k is MobKind => k in MOB_SPECS;

/**
 * One chunk in ten lets slimes spawn underground at any light level. Fixed by
 * the seed, so a player who finds one can build a farm there and it stays one.
 */
export const isSlimeChunk = (seed: number, cx: number, cz: number): boolean => hashFloat(seed, cx, cz, 987234911) < 0.1;

/** Natural sheep colours, weighted as in the original: mostly white, a few greys and browns, a rare pink. */
function naturalWool(r: number): number {
  if (r < 0.818) return 0;
  if (r < 0.868) return 15; // black
  if (r < 0.918) return 7; // gray
  if (r < 0.968) return 8; // light gray
  if (r < 0.9984) return 12; // brown
  return 6; // pink
}

const turnToward = (from: number, to: number, max: number): number => {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + Math.max(-max, Math.min(max, d));
};

export class Mob extends Entity {
  readonly kind: MobKind;
  readonly spec: MobSpec;
  health: number;
  hurtTime = 0;
  invulnerable = 0;
  deathTime = 0;
  air = 300;
  /** Negative while a baby (grows up at 0). */
  growth = 0;
  love = 0;
  loveCooldown = 0;
  panic = 0;
  attackCooldown = 0;
  /** Creeper swell, 0..30 ticks. */
  fuse = 0;
  sheared = false;
  woolColor = 0;
  eggTimer = 6000;
  targetId: string | null = null;
  private wander: { x: number; z: number; ticks: number } | null = null;
  private lookTimer = 0;
  private strafe = 1;
  private shootCooldown = 20;
  /** Last player to hit this mob, for credit and for spiders turning hostile. */
  lastAttacker: string | null = null;
  headYaw = 0;
  /** Persistent mobs (named, bred, farm animals) never despawn. */
  persistent: boolean;
  /** A slime's size: 1, 2 or 4. Everything else is 1. */
  size = 1;
  /** Ticks until a slime's next hop. */
  private hopDelay = 0;
  /** The slime's stretch (+) on a hop and squash (−) on landing, decaying to 0; drawn by the renderer. */
  squish = 0;
  /** Timed effects from splash potions and poison. */
  effects: MobEffect[] = [];
  /** Looting on the weapon that last struck it, for its drops. */
  looting = 0;

  constructor(kind: MobKind, x: number, y: number, z: number, id?: number) {
    const spec = MOB_SPECS[kind];
    super(x, y, z, spec.width, spec.height, id);
    this.kind = kind;
    this.spec = spec;
    this.health = spec.health;
    this.persistent = !spec.hostile;
    this.yaw = Math.random() * Math.PI * 2;
    this.body.stepHeight = 0.6;
    if (kind === "sheep") this.woolColor = naturalWool(Math.random());
    if (kind === "chicken") this.eggTimer = 6000 + Math.floor(Math.random() * 6000);
    if (kind === "slime") this.setSize(1 << Math.floor(Math.random() * 3));
  }

  /** Slimes come in sizes 1, 2 and 4: the box, the health and the bite all scale with it. */
  setSize(n: number, heal = true): void {
    this.size = n;
    this.body.width = this.spec.width * n;
    this.body.height = this.spec.height * n;
    if (heal) this.health = this.spec.health * n * n;
  }

  /** Voices pitch up for babies and small slimes, down for big ones. */
  private get voice(): number {
    if (this.kind === "slime") return 1.6 - this.size * 0.2;
    return this.baby ? 1.5 : 1;
  }

  get baby(): boolean {
    return this.growth < 0;
  }

  setBaby(): void {
    this.growth = -24000;
    this.body.width = this.spec.width / 2;
    this.body.height = this.spec.height / 2;
  }

  get dying(): boolean {
    return this.deathTime > 0;
  }

  get maxHealth(): number {
    return this.spec.health * this.size * this.size;
  }

  heal(n: number): void {
    if (!this.dying) this.health = Math.min(this.maxHealth, this.health + n);
  }

  hasEffect(kind: StatusEffect): boolean {
    return this.effects.some((e) => e.kind === kind);
  }

  private effectLevel(kind: StatusEffect): number {
    return this.effects.find((e) => e.kind === kind)?.amp ?? -1;
  }

  /** A potion's effect on a mob; healing and harming swap for the undead, who also ignore poison and regeneration. */
  applyEffect(ctx: EntityContext, kind: StatusEffect, seconds: number, amp: number, attacker?: string): void {
    const undead = isUndead(this.kind);
    if (kind === "instant_health" || kind === "instant_damage") {
      const harm = (kind === "instant_damage") !== undead;
      if (harm) {
        this.invulnerable = 0;
        this.hurt(ctx, 6 << amp, "magic", this.x, this.z, attacker);
      } else this.heal(4 << amp);
      return;
    }
    if (undead && (kind === "poison" || kind === "regeneration")) return;
    if (seconds <= 0) return;
    const existing = this.effects.find((e) => e.kind === kind);
    if (existing) { existing.ticks = Math.max(existing.ticks, seconds * 20); existing.amp = Math.max(existing.amp, amp); }
    else this.effects.push({ kind, ticks: seconds * 20, amp });
  }

  private tickEffects(ctx: EntityContext): void {
    for (const e of this.effects) {
      e.ticks--;
      if (e.kind === "poison" && e.ticks % Math.max(1, 25 >> e.amp) === 0 && this.health > 1) {
        this.invulnerable = 0;
        this.hurt(ctx, 1, "magic", this.x, this.z);
      }
      if (e.kind === "regeneration" && e.ticks % Math.max(1, 50 >> e.amp) === 0) this.heal(1);
    }
    this.effects = this.effects.filter((e) => e.ticks > 0);
  }

  hurt(ctx: EntityContext, amount: number, source: DamageSource, fromX: number, fromZ: number, attacker?: string, knockback = 0): boolean {
    if (this.dying || this.removed) return false;
    if (this.invulnerable > 0 && source !== "void") return false;
    if ((source === "fire" || source === "lava") && this.hasEffect("fire_resistance")) return false;
    this.health -= amount;
    this.hurtTime = 10;
    this.invulnerable = 10;
    if (attacker) this.lastAttacker = attacker;
    if (attacker && !attacker.startsWith("mob:")) {
      if (this.spec.hostile) this.targetId = attacker;
    }
    // Knockback away from the source.
    const dx = this.body.x - fromX, dz = this.body.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    if (source !== "fire" && source !== "drown" && source !== "fall" && source !== "starve" && source !== "magic") {
      this.body.vx = this.body.vx / 2 + (dx / d) * (0.4 + knockback);
      this.body.vz = this.body.vz / 2 + (dz / d) * (0.4 + knockback);
      if (this.body.onGround) this.body.vy = Math.min(0.4, this.body.vy / 2 + 0.4);
    }
    if (!this.spec.hostile) this.panic = 100;
    ctx.sound(`${this.kind}_hurt`, this.body.x, this.body.y + 0.5, this.body.z, 0.8, this.voice);
    if (this.health <= 0) {
      this.deathTime = 1;
      ctx.sound(`${this.kind}_death`, this.body.x, this.body.y + 0.5, this.body.z, 0.8, this.voice);
    }
    return true;
  }

  tick(ctx: EntityContext): void {
    const b = this.body;
    if (this.dying) {
      this.deathTime++;
      if (this.deathTime >= 20) this.die(ctx);
      b.vx *= 0.5; b.vz *= 0.5;
      travel(ctx.world, b, { forward: 0, strafe: 0, yaw: this.yaw, jump: false, sneak: false, sprint: false, flying: false, speed: 0 });
      return;
    }
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerable > 0) this.invulnerable--;
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (this.loveCooldown > 0) this.loveCooldown--;
    if (this.love > 0) {
      this.love--;
      if (this.age % 10 === 0) ctx.particles("heart", b.x, b.y + b.height + 0.3, b.z, 1);
    }
    if (this.growth < 0) {
      this.growth++;
      if (this.growth === 0) { this.body.width = this.spec.width; this.body.height = this.spec.height; }
    }

    this.tickEffects(ctx);
    if (this.dying) return;
    const move = { forward: 0, jump: false, yaw: this.yaw, speedMul: 1 };
    if (this.kind === "slime") this.slimeAi(ctx, move);
    else if (this.spec.hostile) this.hostileAi(ctx, move);
    else this.passiveAi(ctx, move);

    this.yaw = turnToward(this.yaw, move.yaw, 0.35);
    const wasGround = b.onGround;
    const swift = this.effectLevel("speed"), slow = this.effectLevel("slowness");
    const potionSpeed = Math.max(0, (1 + (swift >= 0 ? 0.2 * (swift + 1) : 0)) * (1 - (slow >= 0 ? 0.15 * (slow + 1) : 0)));
    const res = travel(ctx.world, b, {
      forward: move.forward, strafe: 0, yaw: this.yaw, jump: move.jump, sneak: false, sprint: false, flying: false,
      speed: this.spec.speed * move.speedMul * (this.baby ? 1.3 : 1) * potionSpeed, floats: true,
    });
    // Spiders climb walls.
    if (this.kind === "spider" && b.collidedH && move.forward > 0) b.vy = 0.2;
    // Chickens flutter down.
    if (this.kind === "chicken" && !b.onGround && b.vy < -0.06) { b.vy = -0.06; b.fallDistance = 0; }
    this.walkDist += res.moved;
    if (this.kind === "slime") {
      this.squish *= 0.6;
      if (b.onGround && !wasGround) {
        this.squish = -0.5;
        ctx.sound("slime_squish", b.x, b.y, b.z, 0.3 + this.size * 0.1, this.voice);
        if (this.size > 1) ctx.particles("slime", b.x, b.y + 0.1, b.z, this.size * 4);
      }
    }
    // Chickens flutter and slimes bounce; neither is hurt by a fall.
    if (res.landedFrom > 3 && this.kind !== "chicken" && this.kind !== "slime") this.hurt(ctx, Math.ceil(res.landedFrom - 3), "fall", b.x, b.z);
    this.environment(ctx);
    if (b.y < -64) this.removed = true;
  }

  private environment(ctx: EntityContext): void {
    const b = this.body;
    if (b.inLava) {
      this.fireTicks = 300;
      if (this.age % 10 === 0) this.hurt(ctx, 4, "lava", b.x, b.z);
    }
    if (b.inWater) this.fireTicks = 0;
    if (this.spec.burnsInDay && ctx.daylight > 0.55 && !b.inWater && this.age % 20 === 0) {
      const hx = Math.floor(b.x), hy = Math.floor(b.y + b.height), hz = Math.floor(b.z);
      if (ctx.world.seesSky(hx, hy, hz) && ctx.random() < 0.8) this.fireTicks = Math.max(this.fireTicks, 160);
    }
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.fireTicks % 20 === 0) this.hurt(ctx, 1, "fire", b.x, b.z);
    }
    if (b.eyesInWater) {
      this.air--;
      if (this.air <= -20) { this.air = 0; this.hurt(ctx, 2, "drown", b.x, b.z); }
    } else this.air = 300;
    const head = ctx.world.blockAt(Math.floor(b.x), Math.floor(b.y + b.height * 0.85), Math.floor(b.z));
    if (block(head).opaque && this.age % 10 === 0) this.hurt(ctx, 1, "suffocation", b.x, b.z);
    if (ctx.world.blockAt(Math.floor(b.x), Math.floor(b.y), Math.floor(b.z)) === B.CACTUS && this.age % 10 === 0) this.hurt(ctx, 1, "cactus", b.x, b.z);
  }

  private faceTo(x: number, z: number): number {
    return Math.atan2(-(x - this.body.x), -(z - this.body.z));
  }

  /** Walks toward a point; jumps up single steps; refuses cliffs when merely wandering. */
  private steer(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number }, x: number, z: number, careful: boolean): void {
    const b = this.body;
    move.yaw = this.faceTo(x, z);
    move.forward = 1;
    const ax = Math.floor(b.x - Math.sin(move.yaw) * (b.width / 2 + 0.6));
    const az = Math.floor(b.z - Math.cos(move.yaw) * (b.width / 2 + 0.6));
    const fy = Math.floor(b.y + 0.01);
    const ahead = ctx.world.getBlock(ax, fy, az);
    if (ahead > 0 && block(ahead).solid && b.onGround) {
      const above = ctx.world.blockAt(ax, fy + 1, az);
      const above2 = ctx.world.blockAt(ax, fy + 2, az);
      if (!block(above).solid && !block(above2).solid) move.jump = true;
    }
    if (b.inWater) move.jump = true;
    if (careful && b.onGround) {
      let drop = 0;
      for (let d = 1; d <= 4; d++) {
        const id = ctx.world.getBlock(ax, fy - d, az);
        if (id < 0 || block(id).solid || id === B.WATER) break;
        drop = d;
      }
      const hazard = ctx.world.blockAt(ax, fy - 1, az) === B.LAVA || ctx.world.blockAt(ax, fy, az) === B.LAVA;
      if (drop >= 3 || hazard) { move.forward = 0; this.wander = null; }
    }
  }

  private nearestPlayer(ctx: EntityContext, range: number, filter: (p: PlayerRef) => boolean): PlayerRef | null {
    let best: PlayerRef | null = null, bestD = range;
    for (const p of ctx.players()) {
      if (!filter(p)) continue;
      const d = Math.hypot(p.x - this.body.x, p.y - this.body.y, p.z - this.body.z);
      // An invisible player is noticed only at arm's length.
      if (p.invisible && d > range * 0.15) continue;
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  private canSee(ctx: EntityContext, p: PlayerRef): boolean {
    const b = this.body;
    const ex = b.x, ey = b.y + b.height * 0.85, ez = b.z;
    const tx = p.x, ty = p.y + p.height * 0.9, tz = p.z;
    const dist = Math.hypot(tx - ex, ty - ey, tz - ez);
    const hit = raycastBlocks(ctx.world, ex, ey, ez, tx - ex, ty - ey, tz - ez, dist);
    return !hit || !block(ctx.world.blockAt(hit.x, hit.y, hit.z)).opaque;
  }

  private wanderAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }, chance: number): void {
    const b = this.body;
    if (!this.wander && ctx.random() < chance) {
      const a = ctx.random() * Math.PI * 2, r = 3 + ctx.random() * 7;
      this.wander = { x: b.x + Math.cos(a) * r, z: b.z + Math.sin(a) * r, ticks: 200 };
    }
    if (this.wander) {
      this.wander.ticks--;
      if (this.wander.ticks <= 0 || Math.hypot(this.wander.x - b.x, this.wander.z - b.z) < 1) this.wander = null;
      else this.steer(ctx, move, this.wander.x, this.wander.z, true);
    }
    // Look around at nearby players now and then.
    if (--this.lookTimer <= 0) {
      this.lookTimer = 40 + Math.floor(ctx.random() * 80);
      const p = this.nearestPlayer(ctx, 8, () => true);
      if (p && !this.wander) move.yaw = this.faceTo(p.x, p.z);
    }
  }

  private passiveAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    if (this.panic > 0) {
      this.panic--;
      if (!this.wander || this.wander.ticks <= 0) {
        const a = ctx.random() * Math.PI * 2;
        this.wander = { x: b.x + Math.cos(a) * 8, z: b.z + Math.sin(a) * 8, ticks: 30 };
      }
      this.wander.ticks--;
      this.steer(ctx, move, this.wander.x, this.wander.z, false);
      move.speedMul = 1.9;
      return;
    }
    // Breeding: two animals in love find each other.
    if (this.love > 0 && !this.baby) {
      const mate = ctx.entitiesNear(b.x, b.y, b.z, 8).find(
        (e): e is Mob => e instanceof Mob && e !== this && e.kind === this.kind && e.love > 0 && !e.baby && !e.dying,
      );
      if (mate) {
        this.steer(ctx, move, mate.x, mate.z, false);
        if (Math.hypot(mate.x - b.x, mate.z - b.z) < 1.5 && this.id < mate.id) {
          this.love = mate.love = 0;
          this.loveCooldown = mate.loveCooldown = 6000;
          const child = new Mob(this.kind, (b.x + mate.x) / 2, b.y, (b.z + mate.z) / 2);
          child.setBaby();
          if (this.kind === "sheep") child.woolColor = ctx.random() < 0.5 ? this.woolColor : mate.woolColor;
          ctx.spawn(child);
          ctx.spawn(new XpOrb(b.x, b.y + 0.5, b.z, 1 + Math.floor(ctx.random() * 7)));
          ctx.particles("heart", b.x, b.y + 1, b.z, 6);
        }
        return;
      }
    }
    // Following someone holding food.
    const tempts = this.spec.tempt.map((n) => itemByName(n).id);
    const lure = this.nearestPlayer(ctx, 8, (p) => tempts.includes(p.heldItem));
    if (lure) {
      move.yaw = this.faceTo(lure.x, lure.z);
      if (Math.hypot(lure.x - b.x, lure.z - b.z) > 2.2) this.steer(ctx, move, lure.x, lure.z, true);
      return;
    }
    // Babies stay near a parent.
    if (this.baby && this.age % 40 === 0) {
      const parent = ctx.entitiesNear(b.x, b.y, b.z, 12).find((e) => e instanceof Mob && e.kind === this.kind && !e.baby);
      if (parent && Math.hypot(parent.x - b.x, parent.z - b.z) > 4) this.wander = { x: parent.x, z: parent.z, ticks: 60 };
    }
    this.wanderAi(ctx, move, 1 / 100);
    // Sheep regrow wool by eating grass.
    if (this.kind === "sheep" && this.sheared && ctx.random() < 1 / 800) {
      const gx = Math.floor(b.x), gy = Math.floor(b.y - 0.5), gz = Math.floor(b.z);
      if (ctx.world.blockAt(gx, gy, gz) === B.GRASS) {
        ctx.world.setBlock(gx, gy, gz, B.DIRT);
        this.sheared = false;
      }
    }
    if (this.kind === "chicken" && !this.baby && --this.eggTimer <= 0) {
      this.eggTimer = 6000 + Math.floor(ctx.random() * 6000);
      ctx.dropItem(b.x, b.y + 0.3, b.z, { id: itemByName("egg").id, count: 1 });
      ctx.sound("chicken_egg", b.x, b.y, b.z, 0.6);
    }
    if (ctx.random() < 1 / 400) ctx.sound(`${this.kind}_idle`, b.x, b.y + 0.5, b.z, 0.5, this.baby ? 1.5 : 1);
  }

  private hostileAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    const eligible = (p: PlayerRef) => p.targetable;
    // Spiders keep to themselves in the light unless provoked.
    const bright = ctx.world.brightness(b.x, b.y + 0.5, b.z, ctx.daylight) > 11;
    const passiveNow = this.kind === "spider" && bright && this.lastAttacker === null;
    if (this.age % 20 === 0 && !passiveNow) {
      const current = this.targetId ? ctx.players().find((p) => p.id === this.targetId) : null;
      if (!current || !current.targetable || Math.hypot(current.x - b.x, current.z - b.z) > this.spec.followRange) {
        const candidate = this.nearestPlayer(ctx, this.spec.followRange * (this.kind === "zombie" ? 0.5 : 1), eligible);
        this.targetId = candidate && this.canSee(ctx, candidate) ? candidate.id : null;
      }
    }
    if (passiveNow && this.lastAttacker === null) this.targetId = null;
    const target = this.targetId ? ctx.players().find((p) => p.id === this.targetId) ?? null : null;
    if (!target || !target.targetable) {
      this.targetId = null;
      if (this.kind === "creeper" && this.fuse > 0) this.fuse--;
      this.wanderAi(ctx, move, 1 / 120);
      if (ctx.random() < 1 / 300) ctx.sound(`${this.kind}_idle`, b.x, b.y + 1, b.z, 0.6);
      return;
    }
    const dx = target.x - b.x, dz = target.z - b.z;
    const dist = Math.hypot(dx, dz);
    const dy = target.y - b.y;

    if (this.kind === "creeper") {
      if (dist < 3 && Math.abs(dy) < 3) {
        if (this.fuse === 0) ctx.sound("creeper_hiss", b.x, b.y + 1, b.z, 1);
        this.fuse++;
        move.yaw = this.faceTo(target.x, target.z);
        if (this.fuse >= 30) {
          this.removed = true;
          ctx.explode(b.x, b.y + 0.5, b.z, 3, this);
        }
        return;
      }
      if (dist > 7 && this.fuse > 0) this.fuse--;
      else if (this.fuse > 0) this.fuse = Math.max(0, this.fuse - 1);
      this.steer(ctx, move, target.x, target.z, false);
      return;
    }

    if (this.kind === "skeleton") {
      move.yaw = this.faceTo(target.x, target.z);
      if (dist > 14) this.steer(ctx, move, target.x, target.z, false);
      else if (dist < 5) {
        // Back away while facing the target.
        this.steer(ctx, move, b.x - dx, b.z - dz, true);
        move.yaw = this.faceTo(target.x, target.z);
        move.forward = -0.5;
      } else {
        if (this.age % 60 === 0) this.strafe = -this.strafe;
      }
      if (--this.shootCooldown <= 0 && dist < 16 && this.canSee(ctx, target)) {
        this.shootCooldown = ctx.difficulty === 3 ? 20 : ctx.difficulty === 1 ? 60 : 40;
        this.shoot(ctx, target);
      }
      return;
    }

    // Zombies and spiders: close in and hit.
    this.steer(ctx, move, target.x, target.z, false);
    if (this.kind === "spider" && dist > 2 && dist < 4 && b.onGround && ctx.random() < 0.1) {
      b.vx += (dx / dist) * 0.3; b.vz += (dz / dist) * 0.3; b.vy = 0.4;
    }
    const reach = (b.width + target.width) / 2 + 0.7;
    if (dist < reach && Math.abs(dy) < 1.6 && this.attackCooldown <= 0) {
      this.attackCooldown = 20;
      this.bite(ctx, target, this.spec.attack);
    }
  }

  /**
   * Slimes cannot walk: they gather themselves on the ground, hop, and steer
   * only while in the air. With a target they hop three times as often and
   * face it the whole way; a medium or large slime hurts whoever it touches,
   * the smallest only nudges.
   */
  private slimeAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    if (this.age % 20 === 0) {
      const current = this.targetId ? ctx.players().find((p) => p.id === this.targetId) : null;
      if (!current || !current.targetable || Math.hypot(current.x - b.x, current.z - b.z) > this.spec.followRange) {
        const candidate = this.nearestPlayer(ctx, this.spec.followRange, (p) => p.targetable);
        this.targetId = candidate && this.canSee(ctx, candidate) ? candidate.id : null;
      }
    }
    const target = this.targetId ? ctx.players().find((p) => p.id === this.targetId && p.targetable) ?? null : null;
    if (target) move.yaw = this.faceTo(target.x, target.z);
    else if (b.onGround && ctx.random() < 1 / 40) move.yaw = this.yaw + (ctx.random() - 0.5) * Math.PI;
    if (b.onGround) {
      if (--this.hopDelay <= 0) {
        this.hopDelay = Math.floor((10 + ctx.random() * 20) / (target ? 3 : 1));
        move.jump = true;
        move.forward = 1;
        this.squish = 0.6;
      }
    } else move.forward = 1;
    if (b.inWater || b.inLava) move.jump = true;
    if (!target) {
      this.targetId = null;
      return;
    }
    const dist = Math.hypot(target.x - b.x, target.z - b.z);
    const reach = (b.width + target.width) / 2 + 0.2;
    if (this.size > 1 && dist < reach && target.y < b.y + b.height && target.y + target.height > b.y && this.attackCooldown <= 0) {
      this.attackCooldown = 10;
      this.bite(ctx, target, this.size);
    }
  }

  /** Melee damage scaled by difficulty the way the original does it. */
  private bite(ctx: EntityContext, target: PlayerRef, base: number): void {
    const diff = ctx.difficulty;
    const s = this.effectLevel("strength"), w = this.effectLevel("weakness");
    base = Math.max(0, base + (s >= 0 ? 3 * (s + 1) : 0) - (w >= 0 ? 4 * (w + 1) : 0));
    const dmg = diff === 1 ? Math.min(base, base / 2 + 1) : diff === 3 ? base * 1.5 : base;
    // The attacker's id lets Thorns answer back.
    if (diff > 0 && dmg > 0) ctx.hurtPlayer(target.id, dmg, "mob", this.body.x, this.body.z, 0.4, this.id);
  }

  private shoot(ctx: EntityContext, target: PlayerRef): void {
    const b = this.body;
    const sx = b.x, sy = b.y + b.height * 0.85, sz = b.z;
    const dx = target.x - sx, dz = target.z - sz;
    const dy = target.y + target.height * 0.35 - sy;
    const d = Math.hypot(dx, dz);
    const vyAim = dy + d * 0.2;
    const len = Math.hypot(dx, vyAim, dz) || 1;
    const spread = (14 - ctx.difficulty * 4) * 0.0075;
    const speed = 1.6;
    const vx = (dx / len + (ctx.random() - 0.5) * spread) * speed;
    const vy = (vyAim / len + (ctx.random() - 0.5) * spread) * speed;
    const vz = (dz / len + (ctx.random() - 0.5) * spread) * speed;
    const arrow = new Projectile("arrow", sx, sy, sz, vx, vy, vz, `mob:${this.id}`);
    ctx.spawn(arrow);
    ctx.sound("bow", sx, sy, sz, 0.8, 1 / (ctx.random() * 0.4 + 0.8));
  }

  /** Right-click with an item. Returns what happened, so the caller can consume the item. */
  interact(ctx: EntityContext, itemName: string | null, playerId: string): "fed" | "sheared" | "milked" | "dyed" | null {
    if (this.dying) return null;
    if (itemName && this.spec.tempt.includes(itemName) && !this.baby && this.loveCooldown <= 0 && this.love <= 0) {
      this.love = 600;
      this.lastAttacker = null;
      return "fed";
    }
    if (itemName && this.spec.tempt.includes(itemName) && this.baby) {
      this.growth = Math.min(0, this.growth + 2400);
      return "fed";
    }
    if (this.kind === "sheep" && itemName === "shears" && !this.sheared && !this.baby) {
      this.sheared = true;
      const n = 1 + Math.floor(ctx.random() * 3);
      ctx.dropItem(this.x, this.y + 1, this.z, { id: itemByName(`${WOOL_COLORS[this.woolColor]}_wool`).id, count: n }, (ctx.random() - 0.5) * 0.1, 0.2, (ctx.random() - 0.5) * 0.1);
      ctx.sound("shear", this.x, this.y, this.z, 0.8);
      return "sheared";
    }
    if (this.kind === "sheep" && itemName && itemName.endsWith("_dye")) {
      const color = WOOL_COLORS.indexOf(itemName.replace(/_dye$/, "") as (typeof WOOL_COLORS)[number]);
      if (color >= 0 && color !== this.woolColor) { this.woolColor = color; return "dyed"; }
    }
    if (this.kind === "cow" && itemName === "bucket" && !this.baby) {
      ctx.sound("milk", this.x, this.y, this.z, 0.8);
      return "milked";
    }
    return null;
  }

  private die(ctx: EntityContext): void {
    this.removed = true;
    const b = this.body;
    ctx.particles("poof", b.x, b.y + b.height / 2, b.z, 12);
    if (this.baby) return;
    // A slime bigger than the smallest comes apart into two to four of half its size.
    if (this.kind === "slime" && this.size > 1) {
      const n = 2 + Math.floor(ctx.random() * 3);
      for (let i = 0; i < n; i++) {
        const ox = ((i % 2) - 0.5) * this.size * 0.25, oz = (Math.floor(i / 2) - 0.5) * this.size * 0.25;
        const child = new Mob("slime", b.x + ox, b.y + 0.5, b.z + oz);
        child.setSize(this.size / 2);
        child.targetId = this.lastAttacker && !this.lastAttacker.startsWith("mob:") ? this.lastAttacker : null;
        ctx.spawn(child);
      }
    }
    for (const s of this.loot(ctx)) {
      ctx.dropItem(b.x, b.y + 0.5, b.z, s, (ctx.random() - 0.5) * 0.2, 0.2, (ctx.random() - 0.5) * 0.2);
    }
    // Experience only for kills a player had a hand in, as in the original.
    if (this.lastAttacker && !this.lastAttacker.startsWith("mob:")) {
      ctx.creditKill?.(this.lastAttacker, this.spec.hostile);
      const [lo, hi] = this.kind === "slime" ? [this.size, this.size] : this.spec.xp;
      for (const v of xpOrbValues(lo + Math.floor(ctx.random() * (hi - lo + 1)))) ctx.spawn(new XpOrb(b.x, b.y + 0.5, b.z, v));
    }
  }

  private loot(ctx: EntityContext): ItemStack[] {
    // Looting adds up to one more of each ordinary drop per level.
    const r = (lo: number, hi: number) => lo + Math.floor(ctx.random() * (hi - lo + 1)) + (hi > 0 ? Math.floor(ctx.random() * (this.looting + 1)) : 0);
    const it = (name: string, count: number): ItemStack[] => (count > 0 ? [{ id: itemByName(name).id, count }] : []);
    const burnt = this.fireTicks > 0;
    switch (this.kind) {
      case "pig": return it(burnt ? "cooked_porkchop" : "porkchop", r(1, 3));
      case "cow": return [...it(burnt ? "cooked_beef" : "beef", r(1, 3)), ...it("leather", r(0, 2))];
      case "sheep": return [...it(burnt ? "cooked_mutton" : "mutton", r(1, 2)), ...(this.sheared ? [] : it(`${WOOL_COLORS[this.woolColor]}_wool`, 1))];
      case "chicken": return [...it(burnt ? "cooked_chicken" : "chicken", 1), ...it("feather", r(0, 2))];
      case "zombie": return [...it("rotten_flesh", r(0, 2)), ...(ctx.random() < 0.025 ? it(ctx.random() < 0.33 ? "iron_ingot" : ctx.random() < 0.5 ? "carrot" : "potato", 1) : [])];
      case "skeleton": return [...it("bone", r(0, 2)), ...it("arrow", r(0, 2))];
      case "creeper": return it("gunpowder", r(0, 2));
      case "spider": return [...it("string", r(0, 2)), ...(ctx.random() < 0.33 ? it("spider_eye", 1) : [])];
      case "slime": return this.size === 1 ? it("slime_ball", r(0, 2)) : [];
    }
  }

  snapshot(): EntitySnapshot {
    return {
      ...super.snapshot(),
      health: this.health,
      data: {
        ht: this.hurtTime, dt: this.deathTime, g: this.growth, sh: this.sheared, wc: this.woolColor,
        fu: this.fuse, fi: this.fireTicks > 0 ? 1 : 0, lv: this.love > 0 ? 1 : 0, p: this.persistent ? 1 : 0,
        sz: this.size, sq: Math.round(this.squish * 10),
        ef: this.effects.length ? this.effects.map((e) => [e.kind, e.ticks, e.amp]) : undefined,
      },
    };
  }

  applySnapshot(s: EntitySnapshot): void {
    super.applySnapshot(s);
    if (typeof s.health === "number") this.health = s.health;
    const d = s.data ?? {};
    if (typeof d.ht === "number") this.hurtTime = d.ht;
    if (typeof d.dt === "number") this.deathTime = d.dt;
    if (typeof d.g === "number") {
      if (d.g < 0 && !this.baby) this.setBaby();
      this.growth = d.g;
      if (d.g >= 0) { this.body.width = this.spec.width; this.body.height = this.spec.height; }
    }
    if (typeof d.sh === "boolean") this.sheared = d.sh;
    if (typeof d.wc === "number") this.woolColor = d.wc;
    if (typeof d.fu === "number") this.fuse = d.fu;
    this.fireTicks = d.fi ? 20 : 0;
    this.love = d.lv ? 20 : 0;
    if (typeof d.p === "number") this.persistent = d.p === 1;
    // After the growth reset above, which would otherwise shrink a big slime's box back to one unit.
    if (this.kind === "slime" && (d.sz === 1 || d.sz === 2 || d.sz === 4)) this.setSize(d.sz, false);
    if (typeof d.sq === "number") this.squish = d.sq / 10;
    if (Array.isArray(d.ef)) {
      this.effects = (d.ef as unknown[]).flatMap((e) => (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && typeof e[2] === "number"
        ? [{ kind: e[0] as StatusEffect, ticks: e[1], amp: e[2] }] : []));
    } else this.effects = [];
  }
}

registerChickenSpawner((x, y, z, baby) => {
  const c = new Mob("chicken", x, y, z);
  if (baby) c.setBaby();
  return c;
});

export function createEntityFromSnapshot(s: EntitySnapshot): Entity | null {
  if (isMobKind(s.kind)) {
    const m = new Mob(s.kind, s.x, s.y, s.z, s.id);
    m.applySnapshot(s);
    return m;
  }
  return null;
}

export type { EntityKind };
