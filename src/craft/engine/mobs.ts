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
import { B, block, Face, FACE_DIRS, WOOL_COLORS } from "./blocks";
import {
  Entity, ItemEntity, Projectile, registerChickenSpawner, XpOrb, xpOrbValues,
  type DamageSource, type EntityContext, type EntityKind, type EntitySnapshot, type PlayerRef,
} from "./entities";
import { itemByName, type ItemStack, type StatusEffect } from "./items";
import { moveBody, senseEnvironment, travel, type AABB } from "./physics";
import { raycastBlocks } from "./raycast";
import { hashFloat, Rng } from "./rng";
import { levelForXp, offersForLevel, sanitizeOffer, type Offer } from "./trading";
import { JOB_BLOCKS, professionForBlock, PROFESSIONS, type Profession } from "./villages";
import { DRAGON_PHASES, dragonHurt, dragonParts, dragonTick, newDragonState, type DragonPart, type DragonState } from "./dragon";

export type MobKind =
  | "pig" | "cow" | "sheep" | "chicken" | "zombie" | "skeleton" | "creeper" | "spider" | "slime" | "villager" | "iron_golem"
  | "zombified_piglin" | "ghast" | "magma_cube" | "blaze" | "wither_skeleton" | "piglin" | "hoglin"
  | "enderman" | "silverfish" | "ender_dragon" | "shulker";

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
  /** Unhurt by fire and lava (the Nether's own). */
  fireImmune?: boolean;
  /** Flies rather than walks: no gravity, no fall damage. */
  flies?: boolean;
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
  villager: { health: 20, width: 0.6, height: 1.95, speed: 0.05, hostile: false, attack: 0, tempt: [], burnsInDay: false, followRange: 10, xp: [0, 0] },
  iron_golem: { health: 100, width: 1.4, height: 2.7, speed: 0.06, hostile: false, attack: 0, tempt: [], burnsInDay: false, followRange: 16, xp: [0, 0] },
  // The Nether. Zombified piglins are neutral until struck; piglins spare anyone wearing gold.
  zombified_piglin: { health: 20, width: 0.6, height: 1.95, speed: 0.058, hostile: true, attack: 5, tempt: [], burnsInDay: false, followRange: 35, xp: [5, 5], fireImmune: true },
  ghast: { health: 10, width: 4, height: 4, speed: 0.03, hostile: true, attack: 0, tempt: [], burnsInDay: false, followRange: 64, xp: [5, 5], fireImmune: true, flies: true },
  // Per unit of size, as a slime's.
  magma_cube: { health: 1, width: 0.52, height: 0.52, speed: 0.12, hostile: true, attack: 0, tempt: [], burnsInDay: false, followRange: 16, xp: [1, 1], fireImmune: true },
  blaze: { health: 20, width: 0.6, height: 1.8, speed: 0.06, hostile: true, attack: 6, tempt: [], burnsInDay: false, followRange: 48, xp: [10, 10], fireImmune: true, flies: true },
  wither_skeleton: { health: 20, width: 0.7, height: 2.4, speed: 0.0625, hostile: true, attack: 5, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5], fireImmune: true },
  piglin: { health: 16, width: 0.6, height: 1.95, speed: 0.07, hostile: true, attack: 5, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
  hoglin: { health: 40, width: 1.4, height: 1.4, speed: 0.06, hostile: true, attack: 6, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
  // The End. Endermen are neutral until looked in the eye or struck.
  enderman: { health: 40, width: 0.6, height: 2.9, speed: 0.075, hostile: true, attack: 7, tempt: [], burnsInDay: false, followRange: 64, xp: [5, 5] },
  silverfish: { health: 8, width: 0.4, height: 0.3, speed: 0.07, hostile: true, attack: 1, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
  // One box for the body; the head, neck and wings reach well past it (dragon.ts).
  ender_dragon: { health: 200, width: 6, height: 3, speed: 0, hostile: true, attack: 10, tempt: [], burnsInDay: false, followRange: 150, xp: [0, 0], fireImmune: true, flies: true },
  // A box clinging to a block in an End city, which opens to shoot and leaves only by teleporting.
  shulker: { health: 30, width: 1, height: 1, speed: 0, hostile: true, attack: 0, tempt: [], burnsInDay: false, followRange: 16, xp: [5, 5] },
};

export const MOB_KINDS = Object.keys(MOB_SPECS) as MobKind[];

/** Undead take Smite's extra damage, are hurt by healing and healed by harming, and shrug off poison. */
const UNDEAD = new Set<string>(["zombie", "skeleton", "zombified_piglin", "wither_skeleton"]);
/** Arthropods take Bane of Arthropods' extra damage. */
const ARTHROPODS = new Set<string>(["spider", "silverfish"]);
export const isUndead = (kind: string): boolean => UNDEAD.has(kind);
export const isArthropod = (kind: string): boolean => ARTHROPODS.has(kind);

interface MobEffect { kind: StatusEffect; ticks: number; amp: number }
export const isMobKind = (k: string): k is MobKind => k in MOB_SPECS;
/** Slimes and magma cubes: hopping cubes in three sizes that split when they die. */
export const isCubeMob = (k: string): boolean => k === "slime" || k === "magma_cube";

/**
 * What a piglin trades for a gold ingot, by weight: the original's list, with
 * what this game has no item for folded into its nearest neighbour.
 */
export const BARTER: [string, number, number, number][] = [
  ["ender_pearl", 10, 2, 4], ["string", 20, 3, 9], ["quartz", 20, 5, 12], ["obsidian", 40, 1, 1], ["fire_charge", 40, 1, 1],
  ["leather", 40, 2, 4], ["soul_sand", 40, 2, 8], ["nether_brick", 40, 2, 8], ["arrow", 40, 6, 12], ["gravel", 40, 8, 16],
  ["blackstone", 40, 8, 16], ["iron_nugget", 10, 10, 36], ["potion_fire_resistance", 8, 1, 1], ["splash_potion_fire_resistance", 8, 1, 1],
  ["water_bottle", 10, 1, 1], ["iron_boots", 8, 1, 1],
];

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
  // Villagers: a trade, the level it has reached, its offers, where it lives and works.
  profession: Profession | "none" = "none";
  villagerXp = 0;
  offers: Offer[] = [];
  home: { x: number; z: number } | null = null;
  job: [number, number, number] | null = null;
  /** A mob this one is fighting (zombies after villagers, golems after monsters), by entity id. */
  targetMob: number | null = null;
  private fleeFrom: { x: number; z: number } | null = null;
  /** Zombified piglins: ticks left of anger at `targetId`. */
  anger = 0;
  /** Piglins: ticks left admiring a gold ingot before handing something back, and who gave it. */
  admiring = 0;
  private admirer: string | null = null;
  /** Flyers: where they are heading. */
  private flyTo: { x: number; y: number; z: number } | null = null;
  /** Blazes: shots left in the current burst. */
  private burst = 0;
  /** Endermen: the block carried in its arms (0 for none). */
  carried = 0;
  /** Endermen: ticks left screaming after being stared at, drawn with the jaw open. */
  scream = 0;
  /** The dragon's fight: its phase, where it is flying, the crystal it draws on. */
  dragon: DragonState | null = null;
  /** The dragon's part the next blow lands on (set by whatever aims the blow); unset means the body. */
  hurtPart: DragonPart["name"] | undefined;
  /** Shulkers: the Face of its box that holds to a block; how far its lid is open (0-1) and where it is going; its colour. */
  attach: number = Face.Down;
  peek = 0;
  private peekTo = 0;
  private peekFor = 0;
  shellColor = 0;

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
    if (isCubeMob(kind)) this.setSize(1 << Math.floor(Math.random() * 3));
    if (kind === "ender_dragon") {
      this.dragon = newDragonState();
      this.persistent = true;
      this.body.noClip = true;
    }
    // A shulker is part of the city it guards: it never wanders off or despawns.
    if (kind === "shulker") { this.persistent = true; this.yaw = 0; }
  }

  /** Separate boxes a blow can land on (the dragon's head, wings, tail…), or null for the one body box. */
  hitParts(): { name: string; box: AABB }[] | null {
    if (this.kind !== "ender_dragon") return null;
    return dragonParts(this).map((p) => ({
      name: p.name,
      box: { minX: p.x - p.half, minY: p.y - p.half, minZ: p.z - p.half, maxX: p.x + p.half, maxY: p.y + p.half, maxZ: p.z + p.half },
    }));
  }

  /** Slimes come in sizes 1, 2 and 4: the box, the health and the bite all scale with it. */
  setSize(n: number, heal = true): void {
    this.size = n;
    this.body.width = this.spec.width * n;
    this.body.height = this.spec.height * n;
    if (heal) this.health = this.spec.health * n * n;
  }

  get villagerLevel(): number {
    return levelForXp(this.villagerXp);
  }

  /** Takes up a trade: the first two offers of its first level. */
  setProfession(p: Profession, random: () => number = Math.random): void {
    this.profession = p;
    this.villagerXp = 0;
    this.offers = offersForLevel(p, 1, new Rng(Math.floor(random() * 0x7fffffff)));
  }

  /**
   * Records a trade the player made: the offer's use, the villager's
   * experience, and new offers when that experience reaches the next level.
   * Returns whether the villager levelled up.
   */
  traded(index: number, random: () => number = Math.random): boolean {
    const offer = this.offers[index];
    if (!offer || this.profession === "none") return false;
    const before = this.villagerLevel;
    offer.uses++;
    this.villagerXp += offer.xp;
    const after = this.villagerLevel;
    if (after > before) {
      for (let l = before + 1; l <= after; l++) this.offers.push(...offersForLevel(this.profession, l, new Rng(Math.floor(random() * 0x7fffffff))));
      return true;
    }
    return false;
  }

  /** Voices pitch up for babies and small slimes, down for big ones. */
  private get voice(): number {
    if (isCubeMob(this.kind)) return 1.6 - this.size * 0.2;
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
    if (this.kind === "ender_dragon") {
      const dealt = dragonHurt(this, amount, source, this.hurtPart);
      this.hurtPart = undefined;
      if (dealt <= 0) return false;
      amount = dealt;
      knockback = -1;
    }
    // Endermen slip every arrow and fireball: they vanish before it lands.
    if (this.kind === "enderman" && (source === "arrow" || source === "fireball")) {
      for (let i = 0; i < 16 && !this.teleportRandomly(ctx); i++);
      return false;
    }
    if (this.kind === "enderman" && attacker && !attacker.startsWith("mob:")) { this.targetId = attacker; this.anger = 600; }
    if (this.kind === "shulker") {
      // Shut, its shell turns arrows aside and takes most of any blow.
      const shut = this.peek < 0.1;
      if (shut && source === "arrow") return false;
      if (shut) amount *= 0.2;
      // Hurt and below half, it may flee to another wall.
      if (this.health - amount < this.maxHealth / 2 && this.health - amount > 0 && ctx.random() < 0.25) this.shulkerTeleport(ctx);
    }
    if ((source === "fire" || source === "lava") && (this.hasEffect("fire_resistance") || this.spec.fireImmune)) return false;
    // Fireballs are fire: they bounce off the Nether's own, except a ghast's blast sent back at a ghast.
    if (source === "fireball" && this.spec.fireImmune && this.kind !== "ghast") return false;
    if (source === "wither" && this.kind === "wither_skeleton") return false;
    // Strike one zombified piglin and every one nearby comes for you.
    if (this.kind === "zombified_piglin" && attacker && !attacker.startsWith("mob:")) {
      for (const e of ctx.entitiesNear(this.body.x, this.body.y, this.body.z, 24)) {
        if (e instanceof Mob && e.kind === "zombified_piglin" && !e.dying) { e.targetId = attacker; e.anger = 400 + Math.floor(ctx.random() * 400); }
      }
    }
    if (this.kind === "piglin" && attacker && !attacker.startsWith("mob:")) this.anger = 600;
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
    if (knockback >= 0 && source !== "fire" && source !== "drown" && source !== "fall" && source !== "starve" && source !== "magic" && this.kind !== "iron_golem" && this.kind !== "shulker") {
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
    if (this.kind === "ender_dragon") {
      if (this.hurtTime > 0) this.hurtTime--;
      if (this.invulnerable > 0) this.invulnerable--;
      dragonTick(this, ctx);
      return;
    }
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
    if (this.kind === "shulker") {
      this.shulkerAi(ctx);
      this.environment(ctx);
      return;
    }
    const move = { forward: 0, jump: false, yaw: this.yaw, speedMul: 1 };
    if (isCubeMob(this.kind)) this.slimeAi(ctx, move);
    else if (this.kind === "villager") this.villagerAi(ctx, move);
    else if (this.kind === "iron_golem") this.golemAi(ctx, move);
    else if (this.kind === "ghast") this.ghastAi(ctx, move);
    else if (this.kind === "blaze") this.blazeAi(ctx, move);
    else if (this.kind === "enderman") this.endermanAi(ctx, move);
    else if (this.spec.hostile) this.hostileAi(ctx, move);
    else this.passiveAi(ctx, move);

    this.yaw = turnToward(this.yaw, move.yaw, 0.35);
    if (this.spec.flies) {
      // Flyers steer their own velocity; the world only stops them.
      senseEnvironment(ctx.world, b);
      moveBody(ctx.world, b, b.vx, b.vy, b.vz);
      if (b.collidedH || b.collidedV) this.flyTo = null;
      b.vx *= 0.91; b.vy *= 0.91; b.vz *= 0.91;
      b.fallDistance = 0;
      this.walkDist += Math.hypot(b.x - this.prevX, b.z - this.prevZ);
      this.environment(ctx);
      if (b.y < -64) this.removed = true;
      return;
    }
    const wasGround = b.onGround;
    const swift = this.effectLevel("speed"), slow = this.effectLevel("slowness");
    const potionSpeed = Math.max(0, (1 + (swift >= 0 ? 0.2 * (swift + 1) : 0)) * (1 - (slow >= 0 ? 0.15 * (slow + 1) : 0)));
    const res = travel(ctx.world, b, {
      forward: move.forward, strafe: 0, yaw: this.yaw, jump: move.jump, sneak: false, sprint: false, flying: false,
      speed: this.spec.speed * move.speedMul * (this.baby ? 1.3 : 1) * potionSpeed, floats: true,
      levitation: this.effectLevel("levitation") + 1,
    });
    // Spiders climb walls.
    if (this.kind === "spider" && b.collidedH && move.forward > 0) b.vy = 0.2;
    // Chickens flutter down.
    if (this.kind === "chicken" && !b.onGround && b.vy < -0.06) { b.vy = -0.06; b.fallDistance = 0; }
    this.walkDist += res.moved;
    // A magma cube springs higher the bigger it is.
    if (this.kind === "magma_cube" && res.jumped) b.vy += 0.08 * this.size;
    if (isCubeMob(this.kind)) {
      this.squish *= 0.6;
      if (b.onGround && !wasGround) {
        this.squish = -0.5;
        ctx.sound(this.kind === "magma_cube" ? "magma_cube_squish" : "slime_squish", b.x, b.y, b.z, 0.3 + this.size * 0.1, this.voice);
        if (this.size > 1) ctx.particles(this.kind === "magma_cube" ? "lava_spark" : "slime", b.x, b.y + 0.1, b.z, this.size * 4);
      }
    }
    // Chickens flutter, slimes bounce and golems are iron; none is hurt by a fall.
    if (res.landedFrom > 3 && this.kind !== "chicken" && !isCubeMob(this.kind) && this.kind !== "iron_golem") this.hurt(ctx, Math.ceil(res.landedFrom - 3), "fall", b.x, b.z);
    this.environment(ctx);
    if (b.y < -64) this.removed = true;
  }

  private environment(ctx: EntityContext): void {
    const b = this.body;
    if (this.spec.fireImmune) this.fireTicks = 0;
    else if (b.inLava) {
      this.fireTicks = 300;
      if (this.age % 10 === 0) this.hurt(ctx, 4, "lava", b.x, b.z);
    } else if (this.age % 10 === 0) {
      const feet = ctx.world.blockAt(Math.floor(b.x), Math.floor(b.y + 0.1), Math.floor(b.z));
      if (feet === B.FIRE || feet === B.SOUL_FIRE) { this.fireTicks = Math.max(this.fireTicks, 160); this.hurt(ctx, 1, "fire", b.x, b.z); }
    }
    if (b.inWater) this.fireTicks = 0;
    // Water hurts a blaze; water and rain hurt an enderman, which flees them.
    if (this.kind === "blaze" && b.inWater && this.age % 10 === 0) this.hurt(ctx, 1, "drown", b.x, b.z);
    if (this.kind === "enderman" && this.age % 10 === 0) {
      const wet = b.inWater || (ctx.raining && ctx.world.seesSky(Math.floor(b.x), Math.floor(b.y + b.height), Math.floor(b.z)));
      if (wet) {
        this.hurt(ctx, 1, "drown", b.x, b.z);
        for (let i = 0; i < 8 && !this.teleportRandomly(ctx); i++);
      }
    }
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
    if (this.anger > 0) this.anger--;
    // Neutral until provoked: a zombified piglin only fights whoever angered it (or its fellows).
    const neutral = this.kind === "zombified_piglin" && this.anger <= 0;
    if (this.kind === "piglin" && this.piglinTick(ctx, move)) return;
    const eligible = (p: PlayerRef) => p.targetable && !neutral && (this.kind !== "piglin" || this.anger > 0 || !p.goldArmor);
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
    if (neutral) this.targetId = null;
    const target = this.targetId ? ctx.players().find((p) => p.id === this.targetId) ?? null : null;
    if ((!target || !target.targetable) && this.kind === "zombie" && this.huntVillager(ctx, move)) return;
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

  /** The mob a fighter is after, if it is still there to fight. */
  private mobTarget(ctx: EntityContext, range: number): Mob | null {
    if (this.targetMob === null) return null;
    const b = this.body;
    const t = ctx.entitiesNear(b.x, b.y, b.z, range).find((e): e is Mob => e instanceof Mob && e.id === this.targetMob);
    if (!t || t.dying || t.removed) { this.targetMob = null; return null; }
    return t;
  }

  /** Walks up to another mob and strikes it. */
  private fightMob(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }, t: Mob, damage: number, launch = 0): void {
    const b = this.body;
    this.steer(ctx, move, t.x, t.z, false);
    const reach = (b.width + t.body.width) / 2 + 0.7;
    if (Math.hypot(t.x - b.x, t.z - b.z) < reach && Math.abs(t.y - b.y) < 2 && this.attackCooldown <= 0) {
      this.attackCooldown = 20;
      if (t.hurt(ctx, damage, "mob", b.x, b.z, `mob:${this.id}`) && launch) t.body.vy += launch;
    }
  }

  /** A zombie with no player to chase goes after the nearest villager, as in the original. */
  private huntVillager(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): boolean {
    const b = this.body;
    if (this.age % 20 === 0 && this.targetMob === null) {
      const v = ctx.entitiesNear(b.x, b.y, b.z, 16).find((e): e is Mob => e instanceof Mob && e.kind === "villager" && !e.dying);
      if (v) this.targetMob = v.id;
    }
    const t = this.mobTarget(ctx, 24);
    if (!t) return false;
    this.fightMob(ctx, move, t, 3);
    return true;
  }

  /**
   * Villagers keep near home, run from zombies and from harm, and take up a
   * trade at any free work station nearby; offers restock twice a day.
   */
  private villagerAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    if (this.age % 10 === 0) {
      const z = ctx.entitiesNear(b.x, b.y, b.z, 8).find((e) => e instanceof Mob && e.kind === "zombie" && !e.dying);
      this.fleeFrom = z ? { x: z.x, z: z.z } : null;
    }
    if (this.fleeFrom) {
      const dx = b.x - this.fleeFrom.x, dz = b.z - this.fleeFrom.z;
      const d = Math.hypot(dx, dz) || 1;
      this.steer(ctx, move, b.x + (dx / d) * 6, b.z + (dz / d) * 6, false);
      move.speedMul = 1.8;
      return;
    }
    if (this.age % 100 === 50) this.checkJob(ctx);
    if (this.age % 12000 === 0) for (const o of this.offers) o.uses = 0;
    if (this.panic > 0 || this.home === null) { this.passiveAi(ctx, move); return; }
    // Wander, but keep to the village.
    if (Math.hypot(b.x - this.home.x, b.z - this.home.z) > 20 && ctx.random() < 0.05) {
      this.steer(ctx, move, this.home.x, this.home.z, true);
      return;
    }
    this.passiveAi(ctx, move);
  }

  /** Claims a free work station within reach, or gives up a trade whose station is gone. */
  private checkJob(ctx: EntityContext): void {
    const b = this.body;
    const w = ctx.world;
    if (this.job) {
      const [x, y, z] = this.job;
      if (!w.isLoaded(x, z)) return;
      if (this.profession !== "none" && w.blockAt(x, y, z) === JOB_BLOCKS[this.profession]) return;
      this.job = null;
      // Never traded with: its trade goes with the station, as in the original.
      if (this.villagerXp === 0) { this.profession = "none"; this.offers = []; }
    }
    if (this.profession !== "none" && this.job) return;
    const taken = new Set(ctx.entitiesNear(b.x, b.y, b.z, 32)
      .filter((e): e is Mob => e instanceof Mob && e !== this && e.job !== null)
      .map((e) => e.job!.join(",")));
    const fx = Math.floor(b.x), fy = Math.floor(b.y), fz = Math.floor(b.z);
    for (let dy = -2; dy <= 2; dy++) for (let dz = -8; dz <= 8; dz++) for (let dx = -8; dx <= 8; dx++) {
      const x = fx + dx, y = fy + dy, z = fz + dz;
      const p = professionForBlock(w.blockAt(x, y, z));
      if (!p || taken.has(`${x},${y},${z}`)) continue;
      // A villager with a trade only goes back to that trade's station.
      if (this.profession !== "none" && p !== this.profession) continue;
      this.job = [x, y, z];
      if (this.profession === "none") {
        this.setProfession(p, ctx.random);
        ctx.particles("potion", b.x, b.y + 2, b.z, 8, 0x50e050);
      }
      return;
    }
  }

  /** Iron golems guard their village: they fight monsters (never creepers) and whoever strikes them. */
  private golemAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    if (this.age % 20 === 0 && this.targetMob === null) {
      const m = ctx.entitiesNear(b.x, b.y, b.z, 16)
        .find((e): e is Mob => e instanceof Mob && e.spec.hostile && e.kind !== "creeper" && !e.dying);
      if (m) this.targetMob = m.id;
    }
    // The original's blow: 7 to 21, and it throws its victim into the air.
    const damage = 7 + Math.floor(ctx.random() * 15);
    const mob = this.mobTarget(ctx, 24);
    if (mob) { this.fightMob(ctx, move, mob, damage, 0.4); move.speedMul = 1.4; return; }
    const angry = this.lastAttacker && !this.lastAttacker.startsWith("mob:")
      ? ctx.players().find((p) => p.id === this.lastAttacker && p.targetable) ?? null : null;
    if (angry) {
      this.steer(ctx, move, angry.x, angry.z, false);
      const reach = (b.width + angry.width) / 2 + 0.7;
      if (Math.hypot(angry.x - b.x, angry.z - b.z) < reach && this.attackCooldown <= 0) {
        this.attackCooldown = 20;
        const diff = ctx.difficulty;
        const dmg = diff === 1 ? damage / 2 + 1 : diff === 3 ? damage * 1.5 : damage;
        if (diff > 0) ctx.hurtPlayer(angry.id, dmg, "mob", b.x, b.z, 0.8, this.id);
      }
      return;
    }
    if (this.home && Math.hypot(b.x - this.home.x, b.z - this.home.z) > 16) this.steer(ctx, move, this.home.x, this.home.z, true);
    else this.wanderAi(ctx, move, 1 / 200);
    move.speedMul = 0.6;
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
    // The smallest slime only nudges; every magma cube burns.
    const magma = this.kind === "magma_cube";
    if ((this.size > 1 || magma) && dist < reach && target.y < b.y + b.height && target.y + target.height > b.y && this.attackCooldown <= 0) {
      this.attackCooldown = 10;
      this.bite(ctx, target, magma ? [3, 3, 4, 4, 6][this.size] : this.size);
    }
  }

  /**
   * Endermen: they wander, now and then picking up a block or setting one
   * down, until someone looks one in the eye — then it screams and comes for
   * them, blinking closer whenever they get away. Struck, the same.
   */
  private endermanAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    if (this.anger > 0) this.anger--;
    if (this.scream > 0) this.scream--;
    // Being looked at: checked for every player in range, as the original does.
    for (const p of ctx.players()) {
      if (!p.targetable || p.pumpkin || p.yaw === undefined || p.pitch === undefined) continue;
      if (this.targetId === p.id && this.anger > 0) continue;
      if (this.staredAtBy(ctx, p)) {
        this.targetId = p.id;
        this.anger = 600;
        this.scream = 40;
        ctx.sound("enderman_scream", b.x, b.y + 2.5, b.z, 1.2);
        break;
      }
    }
    const target = this.anger > 0 && this.targetId ? ctx.players().find((p) => p.id === this.targetId && p.targetable) ?? null : null;
    if (!target) {
      this.targetId = null;
      this.wanderAi(ctx, move, 1 / 120);
      if (ctx.mobGriefing !== false) this.handleBlock(ctx);
      // In daylight, out in the open, they blink away somewhere shadier.
      if (ctx.daylight > 0.55 && ctx.random() < 1 / 60 && ctx.world.seesSky(Math.floor(b.x), Math.floor(b.y + b.height), Math.floor(b.z))) this.teleportRandomly(ctx);
      if (ctx.random() < 1 / 300) ctx.sound("enderman_idle", b.x, b.y + 2.5, b.z, 0.7);
      return;
    }
    const dx = target.x - b.x, dz = target.z - b.z, dist = Math.hypot(dx, dz);
    // Too far to walk, or stuck: blink to within a few blocks of the target.
    if ((dist > 16 && ctx.random() < 1 / 20) || (b.collidedH && ctx.random() < 1 / 10)) {
      this.teleportToward(ctx, target.x, target.y, target.z);
      return;
    }
    this.steer(ctx, move, target.x, target.z, false);
    move.speedMul = 1.6;
    const reach = (b.width + target.width) / 2 + 0.9;
    if (dist < reach && Math.abs(target.y - b.y) < 2.5 && this.attackCooldown <= 0) {
      this.attackCooldown = 20;
      this.bite(ctx, target, this.spec.attack);
    }
  }

  /** Whether a player is looking this enderman in the eye (within the original's cone), with a clear line between. */
  private staredAtBy(ctx: EntityContext, p: PlayerRef): boolean {
    const b = this.body;
    const ex = b.x, ey = b.y + 2.55, ez = b.z;
    const px = p.x, py = p.y + (p.height > 1.6 ? 1.62 : 1.27), pz = p.z;
    const tx = ex - px, ty = ey - py, tz = ez - pz;
    const d = Math.hypot(tx, ty, tz);
    if (d > 64 || d < 0.5) return false;
    const yaw = p.yaw!, pitch = p.pitch!;
    const lx = -Math.sin(yaw) * Math.cos(pitch), ly = Math.sin(pitch), lz = -Math.cos(yaw) * Math.cos(pitch);
    const dot = (lx * tx + ly * ty + lz * tz) / d;
    if (dot <= 1 - 0.025 / d) return false;
    const hit = raycastBlocks(ctx.world, px, py, pz, tx, ty, tz, d);
    return !hit || !block(ctx.world.blockAt(hit.x, hit.y, hit.z)).opaque;
  }

  /** Picks up a block within reach (one in twenty ticks tries), or puts the carried one down (one in two thousand). */
  private handleBlock(ctx: EntityContext): void {
    const b = this.body, w = ctx.world;
    if (!this.carried) {
      if (ctx.random() >= 1 / 20) return;
      const x = Math.floor(b.x - 2 + ctx.random() * 4), y = Math.floor(b.y + ctx.random() * 3), z = Math.floor(b.z - 2 + ctx.random() * 4);
      const id = w.blockAt(x, y, z);
      if (!ENDERMAN_HOLDABLE.has(id) || w.getEntity(x, y, z)) return;
      const hit = raycastBlocks(w, b.x, b.y + 2.55, b.z, x + 0.5 - b.x, y + 0.5 - b.y - 2.55, z + 0.5 - b.z, 5);
      if (hit && (hit.x !== x || hit.y !== y || hit.z !== z)) return;
      w.setBlock(x, y, z, B.AIR, 0, "world");
      this.carried = id;
      return;
    }
    if (ctx.random() >= 1 / 2000) return;
    const x = Math.floor(b.x - 1 + ctx.random() * 2), y = Math.floor(b.y + ctx.random() * 2), z = Math.floor(b.z - 1 + ctx.random() * 2);
    if (w.blockAt(x, y, z) !== B.AIR || !block(w.blockAt(x, y - 1, z)).opaque) return;
    if (ctx.placeBlock(x, y, z, this.carried, 0)) this.carried = 0;
  }

  /** Blinks to a random spot within 32 blocks with a floor under it and room to stand. Returns whether it went. */
  teleportRandomly(ctx: EntityContext): boolean {
    const b = this.body;
    return this.teleportTo(ctx, b.x + (ctx.random() - 0.5) * 64, b.y + Math.floor((ctx.random() - 0.5) * 64), b.z + (ctx.random() - 0.5) * 64);
  }

  private teleportToward(ctx: EntityContext, x: number, y: number, z: number): boolean {
    const b = this.body;
    const dx = b.x - x, dy = b.y - y, dz = b.z - z, d = Math.hypot(dx, dy, dz) || 1;
    // To about eight blocks short of it, from its side, jittered.
    return this.teleportTo(ctx, b.x + (ctx.random() - 0.5) * 8 - (dx / d) * 16, b.y + Math.floor((ctx.random() - 0.5) * 16) - (dy / d) * 16, b.z + (ctx.random() - 0.5) * 8 - (dz / d) * 16);
  }

  private teleportTo(ctx: EntityContext, tx: number, ty: number, tz: number): boolean {
    const b = this.body, w = ctx.world;
    const x = Math.floor(tx), z = Math.floor(tz);
    let y = Math.max(1, Math.min(126, Math.floor(ty)));
    if (!w.isLoaded(x, z)) return false;
    while (y > 1 && !block(w.blockAt(x, y - 1, z)).solid) y--;
    const below = w.blockAt(x, y - 1, z);
    if (!block(below).solid || below === B.LAVA || below === B.MAGMA_BLOCK) return false;
    for (let dy = 0; dy < 3; dy++) {
      const id = w.blockAt(x, y + dy, z);
      if (block(id).solid || id === B.WATER || id === B.LAVA) return false;
    }
    ctx.particles("portal", b.x, b.y + 1.5, b.z, 16);
    ctx.sound("enderman_teleport", b.x, b.y + 1.5, b.z, 0.8);
    b.x = x + 0.5; b.y = y; b.z = z + 0.5;
    b.vx = b.vy = b.vz = 0;
    this.prevX = b.x; this.prevY = b.y; this.prevZ = b.z;
    ctx.particles("portal", b.x, b.y + 1.5, b.z, 16);
    ctx.sound("enderman_teleport", b.x, b.y + 1.5, b.z, 0.8);
    return true;
  }

  /** Melee damage scaled by difficulty the way the original does it. */
  private bite(ctx: EntityContext, target: PlayerRef, base: number): void {
    const diff = ctx.difficulty;
    const s = this.effectLevel("strength"), w = this.effectLevel("weakness");
    base = Math.max(0, base + (s >= 0 ? 3 * (s + 1) : 0) - (w >= 0 ? 4 * (w + 1) : 0));
    const dmg = diff === 1 ? Math.min(base, base / 2 + 1) : diff === 3 ? base * 1.5 : base;
    // A hoglin tosses its victim; the attacker's id lets Thorns answer back.
    const kb = this.kind === "hoglin" ? 1.2 : 0.4;
    // A blaze's touch burns like its fireballs, setting its victim alight.
    const source = this.kind === "blaze" ? "fireball" : "mob";
    if (diff > 0 && dmg > 0) ctx.hurtPlayer(target.id, dmg, source, this.body.x, this.body.z, kb, this.id);
    if (diff > 0 && this.kind === "wither_skeleton") ctx.effectPlayer?.(target.id, "wither", 10, 0);
  }

  /**
   * Piglins: a gold ingot held out is taken and admired for six seconds, then
   * something from the barter list is tossed back. Returns true while busy.
   */
  private piglinTick(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): boolean {
    const b = this.body;
    if (this.admiring > 0) {
      this.admiring--;
      move.forward = 0;
      if (this.admirer) {
        const p = ctx.players().find((q) => q.id === this.admirer);
        if (p) move.yaw = this.faceTo(p.x, p.z);
      }
      if (this.admiring === 0) {
        const loot = barter(ctx.random);
        ctx.dropItem(b.x - Math.sin(this.yaw) * 0.6, b.y + 1.2, b.z - Math.cos(this.yaw) * 0.6, loot, -Math.sin(this.yaw) * 0.2, 0.2, -Math.cos(this.yaw) * 0.2);
        ctx.sound("piglin_idle", b.x, b.y + 1.5, b.z, 0.8);
        this.admirer = null;
      }
      return true;
    }
    // Gold on the ground is picked up and admired as if handed over.
    if (this.age % 10 === 0 && this.anger <= 0) {
      const gold = ctx.entitiesNear(b.x, b.y, b.z, 1.6).find((e): e is ItemEntity => e instanceof ItemEntity && !e.removed && e.stack.id === goldIngot());
      if (gold) {
        gold.stack.count--;
        if (gold.stack.count <= 0) gold.removed = true;
        this.admiring = 120;
        this.admirer = null;
        ctx.sound("piglin_admire", b.x, b.y + 1.5, b.z, 0.8);
        return true;
      }
    }
    return false;
  }

  /** A player offers a gold ingot; the piglin takes it unless angry. Returns whether it did. */
  takeGold(ctx: EntityContext, playerId: string): boolean {
    if (this.kind !== "piglin" || this.anger > 0 || this.admiring > 0 || this.dying) return false;
    this.admiring = 120;
    this.admirer = playerId;
    ctx.sound("piglin_admire", this.x, this.y + 1.5, this.z, 0.8);
    return true;
  }

  /** Picks a point within reach of home or target for a flyer to head to. */
  private pickFlyTo(ctx: EntityContext, cx: number, cy: number, cz: number, spread: number): void {
    this.flyTo = {
      x: cx + (ctx.random() - 0.5) * 2 * spread,
      y: Math.max(4, Math.min(120, cy + (ctx.random() - 0.5) * spread)),
      z: cz + (ctx.random() - 0.5) * 2 * spread,
    };
  }

  private flyToward(x: number, y: number, z: number, accel: number, max: number): void {
    const b = this.body;
    const dx = x - b.x, dy = y - (b.y + b.height / 2), dz = z - b.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.5) return;
    b.vx += (dx / d) * accel; b.vy += (dy / d) * accel; b.vz += (dz / d) * accel;
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    if (sp > max) { b.vx *= max / sp; b.vy *= max / sp; b.vz *= max / sp; }
  }

  private flyingTarget(ctx: EntityContext, range: number): PlayerRef | null {
    const b = this.body;
    if (this.age % 20 === 0) {
      const current = this.targetId ? ctx.players().find((p) => p.id === this.targetId) : null;
      if (!current || !current.targetable || Math.hypot(current.x - b.x, current.y - b.y, current.z - b.z) > range) {
        const candidate = this.nearestPlayer(ctx, range, (p) => p.targetable);
        this.targetId = candidate && this.canSee(ctx, candidate) ? candidate.id : null;
      }
    }
    return this.targetId ? ctx.players().find((p) => p.id === this.targetId && p.targetable) ?? null : null;
  }

  /**
   * Ghasts drift in wide lazy loops and, with a player in sight, wail and
   * spit a fireball every three seconds or so. `fuse` doubles as the charge,
   * so the renderer can show the mouth opening.
   */
  private ghastAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    const target = this.flyingTarget(ctx, 64);
    if (!this.flyTo || ctx.random() < 1 / 120 || Math.hypot(this.flyTo.x - b.x, this.flyTo.y - b.y, this.flyTo.z - b.z) < 2) {
      this.pickFlyTo(ctx, b.x, b.y, b.z, 16);
    }
    this.flyToward(this.flyTo!.x, this.flyTo!.y, this.flyTo!.z, 0.01, 0.12);
    move.yaw = target ? this.faceTo(target.x, target.z) : Math.atan2(-b.vx, -b.vz);
    if (target && this.canSee(ctx, target) && ctx.difficulty > 0) {
      this.fuse++;
      if (this.fuse === 10) ctx.sound("ghast_warn", b.x, b.y + 2, b.z, 1.2);
      if (this.fuse >= 20) {
        this.fuse = -40;
        const sx = b.x - Math.sin(move.yaw) * 2.2, sy = b.y + 2, sz = b.z - Math.cos(move.yaw) * 2.2;
        const dx = target.x - sx, dy = target.y + target.height / 2 - sy, dz = target.z - sz;
        const d = Math.hypot(dx, dy, dz) || 1;
        ctx.spawn(new Projectile("fireball", sx, sy - 0.5, sz, (dx / d) * 0.6, (dy / d) * 0.6, (dz / d) * 0.6, `mob:${this.id}`));
        ctx.sound("ghast_shoot", sx, sy, sz, 1.2);
      }
    } else if (this.fuse > 0) this.fuse--;
    else if (this.fuse < 0) this.fuse++;
    if (ctx.random() < 1 / 200) ctx.sound("ghast_idle", b.x, b.y + 2, b.z, 1.5);
  }

  /**
   * Blazes hover a little above their target and throw fire in bursts of
   * three; up close they burn with a touch. With nothing to fight they drift
   * and slowly sink.
   */
  /**
   * A shulker: still, holding to its block. Now and then it lifts its lid a
   * crack to look about; with a player in sight it opens wide and fires a
   * bullet every one to five seconds. Its block gone, it teleports.
   */
  private shulkerAi(ctx: EntityContext): void {
    const b = this.body;
    b.vx = b.vy = b.vz = 0;
    b.fallDistance = 0;
    if (this.age % 10 === 0) {
      const [dx, dy, dz] = FACE_DIRS[this.attach];
      const x = Math.floor(b.x), y = Math.floor(b.y + 0.5), z = Math.floor(b.z);
      if (ctx.world.isLoaded(x, z) && !block(ctx.world.blockAt(x + dx, y + dy, z + dz)).solid && !this.shulkerTeleport(ctx)) {
        // Nowhere to go: it drops, as anything unsupported does.
        const g = ctx.world;
        let fy = y;
        while (fy > 1 && !block(g.blockAt(x, fy - 1, z)).solid) fy--;
        b.y = fy; this.attach = Face.Down;
      }
    }
    const target = this.flyingTarget(ctx, this.spec.followRange);
    if (target) {
      this.peekTo = 1;
      this.peekFor = 0;
      this.headYaw = this.faceTo(target.x, target.z);
      if (--this.shootCooldown <= 0) {
        this.shootCooldown = 20 + Math.floor(ctx.random() * 10) * 10;
        if (ctx.difficulty > 0 && this.peek > 0.5) {
          const [fx, fy, fz] = FACE_DIRS[this.attach];
          // Out of the open side of the box, away from the block it holds.
          const bullet = new Projectile("shulker_bullet", b.x - fx * 0.6, b.y + 0.5 - fy * 0.6, b.z - fz * 0.6, 0, 0, 0, `mob:${this.id}`);
          bullet.homing = target.id;
          ctx.spawn(bullet);
          ctx.sound("shulker_shoot", b.x, b.y + 0.5, b.z, 0.8);
        }
      }
    } else if (this.peekFor > 0) {
      if (--this.peekFor === 0) this.peekTo = 0;
    } else if (ctx.random() < 1 / 120) {
      this.peekTo = ctx.random() < 0.5 ? 0.3 : 0;
      this.peekFor = 40 + Math.floor(ctx.random() * 60);
    }
    const was = this.peek;
    this.peek += Math.max(-0.05, Math.min(0.05, this.peekTo - this.peek));
    if (was < 0.05 && this.peek >= 0.05) ctx.sound("shulker_open", b.x, b.y + 0.5, b.z, 0.6);
    if (was >= 0.05 && this.peek < 0.05) ctx.sound("shulker_close", b.x, b.y + 0.5, b.z, 0.6);
  }

  /** A shulker's escape: up to five tries at an empty cell within eight blocks that has a solid face to hold to. */
  shulkerTeleport(ctx: EntityContext): boolean {
    const b = this.body, w = ctx.world;
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(b.x + (ctx.random() - 0.5) * 16), y = Math.floor(b.y + (ctx.random() - 0.5) * 16), z = Math.floor(b.z + (ctx.random() - 0.5) * 16);
      if (y < 1 || y > 126 || !w.isLoaded(x, z)) continue;
      const here = w.blockAt(x, y, z);
      if (here !== B.AIR) continue;
      // Down first, as it rests on floors by preference.
      const face = [Face.Down, Face.Up, Face.North, Face.South, Face.West, Face.East].find((f) => {
        const [dx, dy, dz] = FACE_DIRS[f];
        return block(w.blockAt(x + dx, y + dy, z + dz)).solid;
      });
      if (face === undefined) continue;
      if (ctx.entitiesNear(x + 0.5, y + 0.5, z + 0.5, 0.9).some((e) => e !== this && e instanceof Mob && e.kind === "shulker")) continue;
      ctx.particles("portal", b.x, b.y + 0.5, b.z, 12);
      ctx.sound("shulker_teleport", b.x, b.y + 0.5, b.z, 0.8);
      b.x = x + 0.5; b.y = y; b.z = z + 0.5;
      this.prevX = b.x; this.prevY = b.y; this.prevZ = b.z;
      this.attach = face;
      this.peek = 0; this.peekTo = 0;
      ctx.particles("portal", b.x, b.y + 0.5, b.z, 12);
      return true;
    }
    return false;
  }

  private blazeAi(ctx: EntityContext, move: { forward: number; jump: boolean; yaw: number; speedMul: number }): void {
    const b = this.body;
    const target = this.flyingTarget(ctx, 48);
    if (this.attackCooldown > 0) this.attackCooldown--;
    if (!target) {
      if (!this.flyTo || ctx.random() < 1 / 100) this.pickFlyTo(ctx, b.x, b.y - 1, b.z, 6);
      this.flyToward(this.flyTo!.x, this.flyTo!.y, this.flyTo!.z, 0.006, 0.06);
      b.vy -= 0.004;
      if (ctx.random() < 1 / 160) ctx.sound("blaze_idle", b.x, b.y + 1, b.z, 0.8);
      return;
    }
    move.yaw = this.faceTo(target.x, target.z);
    const dist = Math.hypot(target.x - b.x, target.z - b.z);
    const tx = dist > 9 ? target.x : b.x + Math.cos(this.age / 30) * 2;
    const tz = dist > 9 ? target.z : b.z + Math.sin(this.age / 30) * 2;
    this.flyToward(tx, target.y + target.height + 1.5, tz, 0.012, dist < 2 ? 0.2 : 0.09);
    if (dist < 1.6 && Math.abs(target.y - b.y) < 2 && this.attackCooldown <= 0) {
      this.attackCooldown = 20;
      this.bite(ctx, target, this.spec.attack);
      return;
    }
    // A burst: a charge-up, then three shots a third of a second apart; then a rest.
    if (--this.shootCooldown > 0) return;
    if (this.burst === 0) {
      this.burst = 3;
      this.shootCooldown = 30;
      ctx.sound("blaze_charge", b.x, b.y + 1, b.z, 0.9);
      return;
    }
    if (this.canSee(ctx, target) && ctx.difficulty > 0) {
      const sx = b.x, sy = b.y + b.height * 0.6, sz = b.z;
      const spread = Math.sqrt(dist) * 0.05;
      const dx = target.x - sx + (ctx.random() - 0.5) * spread * 2, dy = target.y + target.height / 2 - sy, dz = target.z - sz + (ctx.random() - 0.5) * spread * 2;
      const d = Math.hypot(dx, dy, dz) || 1;
      ctx.spawn(new Projectile("small_fireball", sx, sy, sz, (dx / d) * 0.7, (dy / d) * 0.7, (dz / d) * 0.7, `mob:${this.id}`));
      ctx.sound("blaze_shoot", sx, sy, sz, 0.8);
    }
    this.burst--;
    this.shootCooldown = this.burst > 0 ? 6 : 100;
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
  interact(ctx: EntityContext, itemName: string | null, playerId: string): "fed" | "sheared" | "milked" | "dyed" | "trade" | "refuse" | "barter" | null {
    if (this.dying) return null;
    if (this.kind === "piglin") return itemName === "gold_ingot" && this.takeGold(ctx, playerId) ? "barter" : null;
    if (this.kind === "villager") {
      if (this.profession !== "none" && this.offers.length) return "trade";
      // An unemployed villager shakes its head.
      ctx.sound("villager_no", this.x, this.y + 1.5, this.z, 0.8);
      return "refuse";
    }
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
    if (isCubeMob(this.kind) && this.size > 1) {
      const n = 2 + Math.floor(ctx.random() * 3);
      for (let i = 0; i < n; i++) {
        const ox = ((i % 2) - 0.5) * this.size * 0.25, oz = (Math.floor(i / 2) - 0.5) * this.size * 0.25;
        const child = new Mob(this.kind, b.x + ox, b.y + 0.5, b.z + oz);
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
      const [lo, hi] = isCubeMob(this.kind) ? [this.size, this.size] : this.spec.xp;
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
      case "villager": return [];
      case "iron_golem": return [...it("iron_ingot", r(3, 5)), ...it("poppy", r(0, 2))];
      case "zombified_piglin": return [...it("rotten_flesh", r(0, 1)), ...it("gold_nugget", r(0, 1)), ...(ctx.random() < 0.025 ? it("gold_ingot", 1) : [])];
      case "ghast": return [...it("ghast_tear", r(0, 1)), ...it("gunpowder", r(0, 2))];
      case "magma_cube": return this.size > 1 && ctx.random() < 0.25 + this.looting * 0.1 ? it("magma_cream", 1) : [];
      // Blaze rods only for a kill a player made, as in the original.
      case "blaze": return this.lastAttacker && !this.lastAttacker.startsWith("mob:") ? it("blaze_rod", r(0, 1)) : [];
      case "wither_skeleton": return [...(ctx.random() < 0.33 ? it("coal", 1) : []), ...it("bone", r(0, 2))];
      case "piglin": return ctx.random() < 0.085 ? it("golden_sword", 1) : [];
      case "hoglin": return [...it(burnt ? "cooked_porkchop" : "porkchop", r(2, 4)), ...it("leather", r(0, 1))];
      // An enderman drops whatever it was carrying, and sometimes a pearl.
      case "enderman": return [...it("ender_pearl", r(0, 1)), ...(this.carried ? [{ id: this.carried, count: 1 }] : [])];
      case "silverfish": return [];
      case "ender_dragon": return [];
      // Half the time a shell, and Looting helps.
      case "shulker": return ctx.random() < 0.5 + this.looting * 0.0625 ? it("shulker_shell", 1) : [];
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
        ...(this.kind === "villager" ? { vp: this.profession, vx: this.villagerXp, vo: this.offers, vj: this.job ?? undefined } : {}),
        vh: this.home ?? undefined,
        // A guest draws the golem's swing from this; it has no attack of its own to time it.
        ac: this.kind === "iron_golem" && this.attackCooldown > 0 ? this.attackCooldown : undefined,
        ad: this.kind === "piglin" && this.admiring > 0 ? this.admiring : undefined,
        // An enderman's block and scream, for drawing; the dragon's phase and crystal.
        cb: this.kind === "enderman" && this.carried ? this.carried : undefined,
        sc: this.kind === "enderman" && (this.scream > 0 || this.anger > 0) ? 1 : undefined,
        dg: this.dragon ? { p: this.dragon.phase, t: this.dragon.timer, py: this.dragon.podiumY, cr: this.dragon.crystal ?? undefined } : undefined,
        // A shulker's hold, lid and colour; its head turns toward what it watches.
        sk: this.kind === "shulker" ? [this.attach, Math.round(this.peek * 100), this.shellColor, Math.round(this.headYaw * 100)] : undefined,
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
    if (isCubeMob(this.kind) && (d.sz === 1 || d.sz === 2 || d.sz === 4)) this.setSize(d.sz, false);
    if (typeof d.ad === "number") this.admiring = d.ad;
    if (typeof d.sq === "number") this.squish = d.sq / 10;
    if (Array.isArray(d.ef)) {
      this.effects = (d.ef as unknown[]).flatMap((e) => (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number" && typeof e[2] === "number"
        ? [{ kind: e[0] as StatusEffect, ticks: e[1], amp: e[2] }] : []));
    } else this.effects = [];
    if (this.kind === "villager") {
      this.profession = typeof d.vp === "string" && (PROFESSIONS as readonly string[]).includes(d.vp) ? (d.vp as Profession) : "none";
      if (typeof d.vx === "number") this.villagerXp = d.vx;
      if (Array.isArray(d.vo)) this.offers = (d.vo as unknown[]).map(sanitizeOffer).filter((o): o is Offer => o !== null);
      this.job = Array.isArray(d.vj) && d.vj.length === 3 ? (d.vj as [number, number, number]) : null;
    }
    if (this.kind === "iron_golem") this.attackCooldown = typeof d.ac === "number" ? d.ac : 0;
    if (this.kind === "enderman") {
      this.carried = typeof d.cb === "number" && d.cb > 0 && d.cb < 256 ? d.cb : 0;
      this.scream = d.sc === 1 ? 20 : 0;
    }
    if (this.dragon && d.dg && typeof d.dg === "object") {
      const g = d.dg as { p?: unknown; t?: unknown; py?: unknown; cr?: unknown };
      if (typeof g.p === "string" && DRAGON_PHASES.includes(g.p as DragonState["phase"])) this.dragon.phase = g.p as DragonState["phase"];
      if (typeof g.t === "number") this.dragon.timer = g.t;
      if (typeof g.py === "number") this.dragon.podiumY = g.py;
      this.dragon.crystal = typeof g.cr === "number" ? g.cr : null;
    }
    if (this.kind === "shulker" && Array.isArray(d.sk)) {
      const [f, pk, c, hy] = d.sk as unknown[];
      if (typeof f === "number" && f >= 0 && f < 6) this.attach = f;
      if (typeof pk === "number") this.peek = Math.max(0, Math.min(1, pk / 100));
      if (typeof c === "number" && c >= 0 && c < 9) this.shellColor = c;
      if (typeof hy === "number") this.headYaw = hy / 100;
    }
    const h = d.vh as { x?: unknown; z?: unknown } | undefined;
    this.home = h && typeof h.x === "number" && typeof h.z === "number" ? { x: h.x, z: h.z } : null;
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

/** What an enderman will pick up: the soft ground and the plants on it, as in the original. */
const ENDERMAN_HOLDABLE = new Set<number>([
  B.GRASS, B.DIRT, B.COARSE_DIRT, B.PODZOL, B.SAND, B.RED_SAND, B.GRAVEL, B.CLAY, B.MUD, B.MOSS, B.DANDELION, B.POPPY,
  B.BLUE_ORCHID, B.ALLIUM, B.CORNFLOWER, B.OXEYE_DAISY, B.RED_TULIP, B.LILY_OF_THE_VALLEY, B.BROWN_MUSHROOM, B.RED_MUSHROOM,
  B.TNT, B.CACTUS, B.PUMPKIN, B.CARVED_PUMPKIN, B.MELON, B.NETHERRACK, B.CRIMSON_NYLIUM, B.WARPED_NYLIUM, B.CRIMSON_FUNGUS,
  B.WARPED_FUNGUS, B.CRIMSON_ROOTS, B.WARPED_ROOTS, B.SOUL_SAND, B.SOUL_SOIL,
]);

let goldId = -1;
const goldIngot = () => (goldId < 0 ? (goldId = itemByName("gold_ingot").id) : goldId);

/** One roll of the piglin barter table. */
export function barter(random: () => number): ItemStack {
  const total = BARTER.reduce((t, [, w]) => t + w, 0);
  let roll = random() * total;
  for (const [name, w, lo, hi] of BARTER) {
    roll -= w;
    if (roll < 0) return { id: itemByName(name).id, count: lo + Math.floor(random() * (hi - lo + 1)) };
  }
  return { id: itemByName("gravel").id, count: 8 };
}
