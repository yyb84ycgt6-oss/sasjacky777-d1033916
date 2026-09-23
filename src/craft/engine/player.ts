/**
 * The player: position, inventory, and the survival rules.
 *
 * Health and hunger follow the original precisely because they are the game's
 * pacing — every action costs "exhaustion", four exhaustion costs a point of
 * saturation (hidden) and only then a point of food, a full bar heals fast and
 * 18+ heals slowly, and an empty bar starves you down to a floor that depends
 * on difficulty. A player who knows the original can plan a trip by it.
 */
import { B, block } from "./blocks";
import { Inventory } from "./inventory";
import { itemDef, type FoodInfo, type ItemStack, type StatusEffect } from "./items";
import { newBody, travel, type Body, type BlockReader } from "./physics";
import type { DamageSource } from "./entities";

export type GameMode = "survival" | "creative" | "adventure" | "spectator";

export interface PlayerInput {
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export interface Effect {
  kind: StatusEffect;
  ticks: number;
  amp: number;
}

export type PlayerEvent =
  | { type: "hurt"; source: DamageSource; amount: number }
  | { type: "death"; source: DamageSource; message: string }
  | { type: "levelup"; level: number }
  | { type: "land"; distance: number; block: number }
  | { type: "splash" }
  | { type: "jump" }
  | { type: "eat"; item: number };

export interface SurvivalRules {
  difficulty: 0 | 1 | 2 | 3;
  naturalRegeneration: boolean;
  raining: boolean;
}

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const SNEAK_HEIGHT = 1.5;
export const SNEAK_EYE = 1.27;

/** Points needed to go from `level` to the next. */
export function xpToNext(level: number): number {
  return level >= 30 ? 112 + (level - 30) * 9 : level >= 15 ? 37 + (level - 15) * 5 : 7 + level * 2;
}

const DEATH_MESSAGES: Record<DamageSource, string> = {
  mob: "was slain", arrow: "was shot", explosion: "blew up", fall: "hit the ground too hard", fire: "burned to death",
  lava: "tried to swim in lava", drown: "drowned", starve: "starved to death", void: "fell out of the world",
  cactus: "was pricked to death", player: "was slain", magic: "died", suffocation: "suffocated in a wall",
};

export class Player {
  body: Body;
  yaw = 0;
  pitch = 0;
  prevX: number; prevY: number; prevZ: number;
  inventory = new Inventory();
  health = 20;
  food = 20;
  saturation = 5;
  exhaustion = 0;
  air = 300;
  xpLevel = 0;
  xpPoints = 0;
  gameMode: GameMode = "survival";
  flying = false;
  spawn: { x: number; y: number; z: number } | null = null;
  hurtTime = 0;
  invulnerable = 0;
  private lastDamage = 0;
  dead = false;
  deathTime = 0;
  deathMessage = "";
  fireTicks = 0;
  private foodTimer = 0;
  effects: Effect[] = [];
  sneaking = false;
  sprinting = false;
  /** Ticks since the last swing; the attack meter charges back up over 1 / attackSpeed seconds. */
  attackTicks = 100;
  walkDist = 0;
  prevWalkDist = 0;
  sleeping: { x: number; y: number; z: number } | null = null;
  sleepTicks = 0;
  events: PlayerEvent[] = [];

  constructor(public readonly id: string, public name: string, x = 0, y = 80, z = 0) {
    this.body = newBody(x, y, z, PLAYER_WIDTH, PLAYER_HEIGHT, EYE_HEIGHT);
    this.prevX = x; this.prevY = y; this.prevZ = z;
  }

  get survivalLike(): boolean {
    return this.gameMode === "survival" || this.gameMode === "adventure";
  }
  get canFly(): boolean {
    return this.gameMode === "creative" || this.gameMode === "spectator";
  }
  get eyeY(): number {
    return this.body.y + this.body.eyeHeight;
  }
  get armor(): number {
    return this.inventory.armorPoints();
  }

  setGameMode(mode: GameMode): void {
    this.gameMode = mode;
    this.body.noClip = mode === "spectator";
    if (mode === "spectator") this.flying = true;
    else if (!this.canFly) this.flying = false;
    if (!this.survivalLike) { this.fireTicks = 0; this.air = 300; }
  }

  /** Attack strength 0..1 from the swing cooldown (the 1.9+ combat meter). */
  attackStrength(): number {
    const held = this.inventory.held;
    const speed = held ? itemDef(held.id)?.attackSpeed ?? 4 : 4;
    const cooldown = 20 / speed;
    return Math.min(1, (this.attackTicks + 0.5) / cooldown);
  }

  addEffect(kind: StatusEffect, seconds: number, amp = 0): void {
    const existing = this.effects.find((e) => e.kind === kind);
    if (existing) { existing.ticks = Math.max(existing.ticks, seconds * 20); existing.amp = Math.max(existing.amp, amp); }
    else this.effects.push({ kind, ticks: seconds * 20, amp });
  }

  hasEffect(kind: StatusEffect): boolean {
    return this.effects.some((e) => e.kind === kind);
  }

  addExhaustion(n: number): void {
    if (this.survivalLike) this.exhaustion = Math.min(40, this.exhaustion + n);
  }

  heal(n: number): void {
    if (this.dead) return;
    this.health = Math.min(20, this.health + n);
  }

  canEat(food: FoodInfo): boolean {
    return !this.survivalLike || this.food < 20 || !!food.alwaysEdible;
  }

  eat(item: ItemStack, random: () => number): void {
    const food = itemDef(item.id)?.food;
    if (!food) return;
    this.food = Math.min(20, this.food + food.hunger);
    this.saturation = Math.min(this.food, this.saturation + food.saturation);
    if (food.effect && random() < food.effect[2]) this.addEffect(food.effect[0], food.effect[1], 0);
    if (itemDef(item.id)?.name === "golden_apple") this.addEffect("absorption", 120, 0);
    this.events.push({ type: "eat", item: item.id });
  }

  addXp(points: number): void {
    this.xpPoints += points;
    while (this.xpPoints >= xpToNext(this.xpLevel)) {
      this.xpPoints -= xpToNext(this.xpLevel);
      this.xpLevel++;
      if (this.xpLevel % 5 === 0) this.events.push({ type: "levelup", level: this.xpLevel });
    }
  }

  get xpProgress(): number {
    return this.xpPoints / xpToNext(this.xpLevel);
  }

  /** Experience dropped on death: 7 per level, capped at 100. */
  deathXp(): number {
    return Math.min(100, this.xpLevel * 7);
  }

  /**
   * Takes damage after armour. Returns the damage actually dealt (0 if
   * ignored: creative, invulnerable, or a weaker hit during the immunity window).
   */
  hurt(amount: number, source: DamageSource, fromX?: number, fromZ?: number, knockback = 0): number {
    if (this.dead || amount <= 0) return 0;
    if (!this.survivalLike && source !== "void") return 0;
    if (this.sleeping) this.sleeping = null;
    let dealt = amount;
    if (this.invulnerable > 10) {
      if (amount <= this.lastDamage) return 0;
      dealt = amount - this.lastDamage;
    }
    const armored = source !== "fall" && source !== "drown" && source !== "starve" && source !== "void" && source !== "fire" && source !== "magic" && source !== "suffocation";
    if (armored) {
      const armor = this.inventory.armorPoints();
      const tough = this.inventory.armorToughness();
      const reduced = Math.min(20, Math.max(armor / 5, armor - dealt / (2 + tough / 4)));
      dealt *= 1 - reduced / 25;
      const wear = Math.max(1, Math.floor(amount / 4));
      this.inventory.armor = this.inventory.armor.map((a) => {
        if (!a) return a;
        const max = itemDef(a.id)?.durability ?? 0;
        const damage = (a.damage ?? 0) + wear;
        return max && damage >= max ? null : { ...a, damage };
      });
    }
    // Absorption hearts (golden apple) soak damage first.
    const absorb = this.effects.find((e) => e.kind === "absorption");
    if (absorb) {
      const pool = 4 * (absorb.amp + 1);
      const used = Math.min(pool, dealt);
      dealt -= used;
      if (used >= pool) this.effects = this.effects.filter((e) => e !== absorb);
    }
    this.lastDamage = amount;
    this.invulnerable = 20;
    this.hurtTime = 10;
    this.addExhaustion(0.1);
    if (dealt > 0) this.health -= dealt;
    if (fromX !== undefined && fromZ !== undefined && knockback > 0) {
      const dx = this.body.x - fromX, dz = this.body.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      this.body.vx = this.body.vx / 2 + (dx / d) * knockback;
      this.body.vz = this.body.vz / 2 + (dz / d) * knockback;
      if (this.body.onGround) this.body.vy = Math.min(0.4, this.body.vy / 2 + knockback);
    }
    this.events.push({ type: "hurt", source, amount: dealt });
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
      this.deathTime = 0;
      this.deathMessage = `${this.name} ${DEATH_MESSAGES[source]}`;
      this.events.push({ type: "death", source, message: this.deathMessage });
    }
    return dealt;
  }

  respawn(x: number, y: number, z: number): void {
    this.dead = false;
    this.deathTime = 0;
    this.health = 20;
    this.food = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = 300;
    this.fireTicks = 0;
    this.effects = [];
    this.body.x = x; this.body.y = y; this.body.z = z;
    this.body.vx = this.body.vy = this.body.vz = 0;
    this.body.fallDistance = 0;
    this.prevX = x; this.prevY = y; this.prevZ = z;
    this.invulnerable = 60;
  }

  beginTick(): void {
    this.prevX = this.body.x; this.prevY = this.body.y; this.prevZ = this.body.z;
    this.prevWalkDist = this.walkDist;
  }

  tick(world: BlockReader, input: PlayerInput, rules: SurvivalRules): void {
    if (this.dead) { this.deathTime++; return; }
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerable > 0) this.invulnerable--;
    this.attackTicks++;

    if (this.sleeping) {
      this.sleepTicks++;
      input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    }

    // Sneaking shrinks the hitbox; standing back up needs headroom.
    const b = this.body;
    this.sneaking = input.sneak && !this.flying && !b.inWater;
    const wantHeight = this.sneaking ? SNEAK_HEIGHT : PLAYER_HEIGHT;
    if (wantHeight > b.height) {
      const hx = Math.floor(b.x), hy = Math.floor(b.y + PLAYER_HEIGHT - 0.01), hz = Math.floor(b.z);
      if (!block(Math.max(0, world.getBlock(hx, hy, hz))).solid) b.height = wantHeight;
    } else b.height = wantHeight;
    b.eyeHeight = b.height === PLAYER_HEIGHT ? EYE_HEIGHT : SNEAK_EYE;

    const canSprint = !this.survivalLike || this.food > 6;
    if (input.sprint && input.forward > 0.5 && canSprint && !this.sneaking) this.sprinting = true;
    if (input.forward <= 0.5 || this.sneaking || !canSprint || (b.collidedH && !this.flying)) this.sprinting = false;

    const wasInWater = b.inWater;
    const speedBoost = this.hasEffect("speed") ? 1.2 : 1;
    const res = travel(world, b, {
      forward: input.forward, strafe: input.strafe, yaw: this.yaw, jump: input.jump, sneak: input.sneak,
      sprint: this.sprinting, flying: this.flying, speed: 0.1 * speedBoost,
    });
    if (!wasInWater && b.inWater && b.vy < -0.3) this.events.push({ type: "splash" });
    this.walkDist += res.moved;
    if (res.jumped) {
      this.addExhaustion(this.sprinting ? 0.2 : 0.05);
      this.events.push({ type: "jump" });
    }
    if (this.sprinting) this.addExhaustion(0.1 * res.moved);
    else if (b.inWater) this.addExhaustion(0.01 * res.moved);
    if (b.onGround && this.flying && this.gameMode !== "spectator") this.flying = false;

    if (res.landedFrom > 0) {
      const ground = world.getBlock(Math.floor(b.x), Math.floor(b.y - 0.2), Math.floor(b.z));
      this.events.push({ type: "land", distance: res.landedFrom, block: ground });
      if (res.landedFrom > 3 && this.survivalLike) {
        const soft = ground === B.HAY ? 0.2 : ground === B.WATER ? 0 : 1;
        const dmg = Math.ceil((res.landedFrom - 3) * soft);
        if (dmg > 0) this.hurt(dmg, "fall");
      }
    }
    if (this.dead) return;
    this.environment(world, rules);
    this.metabolism(rules);
    this.tickEffects();
  }

  private environment(world: BlockReader, rules: SurvivalRules): void {
    const b = this.body;
    if (!this.survivalLike) return;
    if (b.eyesInWater && !this.hasEffect("night_vision")) {
      this.air--;
      if (this.air <= -20) { this.air = 0; this.hurt(2, "drown"); }
    } else this.air = Math.min(300, this.air + 5);
    if (b.inLava) {
      this.fireTicks = 300;
      this.hurt(4, "lava");
    }
    if (b.inWater || (rules.raining && this.fireTicks > 0 && this.skyAbove(world))) this.fireTicks = 0;
    if (this.fireTicks > 0) {
      this.fireTicks--;
      if (this.fireTicks % 20 === 0) this.hurt(1, "fire");
    }
    if (b.y < -40) this.hurt(4, "void");
    // Cactus pricks on contact, sides included.
    const x0 = Math.floor(b.x - 0.35), x1 = Math.floor(b.x + 0.35), z0 = Math.floor(b.z - 0.35), z1 = Math.floor(b.z + 0.35);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      if (world.getBlock(x, Math.floor(b.y + 0.2), z) === B.CACTUS || world.getBlock(x, Math.floor(b.y - 0.1), z) === B.CACTUS) {
        this.hurt(1, "cactus");
      }
    }
    const head = world.getBlock(Math.floor(b.x), Math.floor(this.eyeY), Math.floor(b.z));
    if (head > 0 && block(head).opaque && !b.noClip) this.hurt(1, "suffocation");
  }

  private skyAbove(world: BlockReader): boolean {
    const x = Math.floor(this.body.x), z = Math.floor(this.body.z);
    for (let y = Math.floor(this.eyeY) + 1; y < 128; y++) {
      const id = world.getBlock(x, y, z);
      if (id > 0 && block(id).solid) return false;
    }
    return true;
  }

  private metabolism(rules: SurvivalRules): void {
    if (!this.survivalLike) return;
    if (rules.difficulty === 0) {
      // Peaceful: hunger and health refill on their own.
      if (this.foodTimer++ % 20 === 0) {
        if (this.health < 20) this.heal(1);
        if (this.food < 20) this.food++;
      }
      return;
    }
    if (this.exhaustion > 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.food = Math.max(0, this.food - 1);
    }
    const regen = rules.naturalRegeneration;
    if (regen && this.saturation > 0 && this.health < 20 && this.food >= 20) {
      if (++this.foodTimer >= 10) {
        const s = Math.min(this.saturation, 6);
        this.heal(s / 6);
        this.addExhaustion(s);
        this.foodTimer = 0;
      }
    } else if (regen && this.food >= 18 && this.health < 20) {
      if (++this.foodTimer >= 80) {
        this.heal(1);
        this.addExhaustion(6);
        this.foodTimer = 0;
      }
    } else if (this.food <= 0) {
      if (++this.foodTimer >= 80) {
        if (this.health > 10 || rules.difficulty === 3 || (this.health > 1 && rules.difficulty === 2)) this.hurt(1, "starve");
        this.foodTimer = 0;
      }
    } else this.foodTimer = 0;
  }

  private tickEffects(): void {
    for (const e of this.effects) {
      e.ticks--;
      if (e.kind === "regeneration" && e.ticks % Math.max(1, 50 >> e.amp) === 0) this.heal(1);
      if (e.kind === "poison" && e.ticks % Math.max(1, 25 >> e.amp) === 0 && this.health > 1) this.hurt(1, "magic");
      if (e.kind === "hunger") this.addExhaustion(0.005 * (e.amp + 1));
    }
    this.effects = this.effects.filter((e) => e.ticks > 0);
  }

  toJSON(): PlayerSave {
    const b = this.body;
    return {
      x: b.x, y: b.y, z: b.z, yaw: this.yaw, pitch: this.pitch, health: this.health, food: this.food,
      saturation: this.saturation, exhaustion: this.exhaustion, air: this.air, xpLevel: this.xpLevel, xpPoints: this.xpPoints,
      gameMode: this.gameMode, flying: this.flying, spawn: this.spawn, inventory: this.inventory.toJSON(), effects: this.effects,
      fireTicks: this.fireTicks, dead: this.dead,
    };
  }

  load(s: Partial<PlayerSave>): void {
    const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
    this.body.x = num(s.x, this.body.x); this.body.y = num(s.y, this.body.y); this.body.z = num(s.z, this.body.z);
    this.prevX = this.body.x; this.prevY = this.body.y; this.prevZ = this.body.z;
    this.yaw = num(s.yaw, 0); this.pitch = num(s.pitch, 0);
    this.health = Math.max(0, Math.min(20, num(s.health, 20)));
    this.food = Math.max(0, Math.min(20, num(s.food, 20)));
    this.saturation = num(s.saturation, 5); this.exhaustion = num(s.exhaustion, 0);
    this.air = num(s.air, 300); this.xpLevel = num(s.xpLevel, 0); this.xpPoints = num(s.xpPoints, 0);
    this.setGameMode(s.gameMode ?? "survival");
    this.flying = !!s.flying && this.canFly;
    this.spawn = s.spawn ?? null;
    this.inventory.load(s.inventory);
    this.effects = Array.isArray(s.effects) ? s.effects.filter((e) => e && typeof e.ticks === "number") : [];
    this.fireTicks = num(s.fireTicks, 0);
    if (s.dead || this.health <= 0) { this.dead = true; this.health = 0; }
  }
}

export interface PlayerSave {
  x: number; y: number; z: number; yaw: number; pitch: number;
  health: number; food: number; saturation: number; exhaustion: number; air: number;
  xpLevel: number; xpPoints: number; gameMode: GameMode; flying: boolean;
  spawn: { x: number; y: number; z: number } | null;
  inventory: ReturnType<Inventory["toJSON"]>;
  effects: Effect[];
  fireTicks: number;
  dead: boolean;
}
