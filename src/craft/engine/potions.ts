/**
 * Potions: what each one does, and what brewing turns into what.
 *
 * Every variant is its own item (`potion_swiftness`, `long_potion_swiftness`,
 * `strong_potion_swiftness`, and a `splash_` twin of each) rather than one
 * potion item carrying data. Potions do not stack, so nothing is lost, and it
 * keeps every place that handles items — crafting, chests, the creative menu,
 * `/give`, saves, the network — working without a special case.
 *
 * Durations and strengths follow the original's table, so a brewer's memory of
 * "three minutes, eight with redstone" holds. This file only describes; the
 * item registry registers the items and brewing.ts runs the stand.
 */
import type { StatusEffect } from "./items";

export interface PotionEffect {
  effect: StatusEffect;
  /** Seconds; 0 for instant effects. */
  seconds: number;
  /** Amplifier: 0 is level I. */
  amp: number;
}

export interface PotionDef {
  /** Item name without the splash_ prefix. */
  key: string;
  displayName: string;
  /** Liquid colour, for the icon and the splash. */
  color: string;
  effects: PotionEffect[];
  /** Texture key: variants of one effect share a bottle. */
  art: string;
}

const P: PotionDef[] = [];
const def = (key: string, displayName: string, color: string, art: string, effects: PotionEffect[] = []) => {
  P.push({ key, displayName, color, effects, art });
};

// The bases: water, and the three dead ends a wrong first ingredient makes.
def("water_bottle", "Water Bottle", "#385dc6", "water");
def("awkward_potion", "Awkward Potion", "#385dc6", "water");
def("mundane_potion", "Mundane Potion", "#385dc6", "water");
def("thick_potion", "Thick Potion", "#385dc6", "water");

/** An effect potion in its normal, long (redstone) and strong (glowstone) forms. */
function family(
  name: string, title: string, color: string, effect: StatusEffect,
  normal: number, long: number | null, strong: [number, number] | null,
): void {
  def(`potion_${name}`, `Potion of ${title}`, color, name, [{ effect, seconds: normal, amp: 0 }]);
  if (long !== null) def(`long_potion_${name}`, `Potion of ${title} (long)`, color, name, [{ effect, seconds: long, amp: 0 }]);
  if (strong) def(`strong_potion_${name}`, `Potion of ${title} II`, color, name, [{ effect, seconds: strong[0], amp: strong[1] }]);
}

family("night_vision", "Night Vision", "#1f1fa1", "night_vision", 180, 480, null);
family("invisibility", "Invisibility", "#7f8392", "invisibility", 180, 480, null);
family("fire_resistance", "Fire Resistance", "#e49a3a", "fire_resistance", 180, 480, null);
family("swiftness", "Swiftness", "#7cafc6", "speed", 180, 480, [90, 1]);
family("slowness", "Slowness", "#5a6c81", "slowness", 90, 240, [20, 3]);
family("healing", "Healing", "#f82423", "instant_health", 0, null, [0, 1]);
family("harming", "Harming", "#430a09", "instant_damage", 0, null, [0, 1]);
family("poison", "Poison", "#4e9331", "poison", 45, 90, [22, 1]);
family("regeneration", "Regeneration", "#cd5cab", "regeneration", 45, 90, [22, 1]);
family("strength", "Strength", "#932423", "strength", 180, 480, [90, 1]);
family("weakness", "Weakness", "#484d48", "weakness", 90, 240, null);
family("water_breathing", "Water Breathing", "#2e5299", "water_breathing", 180, 480, null);

export const POTIONS: readonly PotionDef[] = P;
const BY_KEY = new Map(P.map((p) => [p.key, p]));

export function potionByKey(key: string): PotionDef | undefined {
  return BY_KEY.get(key);
}

/** The potion an item name is, with whether it is the splash kind; undefined for anything else. */
export function potionOfItem(name: string): { potion: PotionDef; splash: boolean } | undefined {
  const splash = name.startsWith("splash_");
  const potion = BY_KEY.get(splash ? name.slice(7) : name);
  return potion ? { potion, splash } : undefined;
}

/** Splash potions last three quarters as long as the drink, as in the original. */
export function splashSeconds(seconds: number): number {
  return Math.floor(seconds * 0.75);
}

/**
 * Brewing: [input potion key, ingredient item name] → output potion key.
 * The splash conversion (gunpowder) is handled separately, since it applies to
 * every potion alike.
 */
const BREWS: [string, string, string][] = [];
const brew = (from: string, ingredient: string, to: string) => { BREWS.push([from, ingredient, to]); };

brew("water_bottle", "nether_wart", "awkward_potion");
for (const i of ["sugar", "glistering_melon_slice", "spider_eye", "ghast_tear", "blaze_powder", "magma_cream", "redstone"]) brew("water_bottle", i, "mundane_potion");
brew("water_bottle", "glowstone_dust", "thick_potion");
brew("water_bottle", "fermented_spider_eye", "potion_weakness");

const AWKWARD: [string, string][] = [
  ["sugar", "swiftness"], ["glistering_melon_slice", "healing"], ["spider_eye", "poison"], ["ghast_tear", "regeneration"],
  ["blaze_powder", "strength"], ["magma_cream", "fire_resistance"], ["golden_carrot", "night_vision"], ["pufferfish", "water_breathing"],
];
for (const [i, name] of AWKWARD) brew("awkward_potion", i, `potion_${name}`);

// Redstone lengthens, glowstone strengthens; each undoes the other.
for (const p of P) {
  const m = /^potion_(.+)$/.exec(p.key);
  if (!m) continue;
  const name = m[1];
  if (BY_KEY.has(`long_potion_${name}`)) {
    brew(p.key, "redstone", `long_potion_${name}`);
    if (BY_KEY.has(`strong_potion_${name}`)) brew(`strong_potion_${name}`, "redstone", `long_potion_${name}`);
  }
  if (BY_KEY.has(`strong_potion_${name}`)) {
    brew(p.key, "glowstone_dust", `strong_potion_${name}`);
    if (BY_KEY.has(`long_potion_${name}`)) brew(`long_potion_${name}`, "glowstone_dust", `strong_potion_${name}`);
  }
}

// A fermented spider eye corrupts a potion into its opposite, keeping its form where the opposite has one.
const CORRUPT: [string, string][] = [
  ["swiftness", "slowness"], ["healing", "harming"], ["poison", "harming"], ["night_vision", "invisibility"],
];
for (const [from, to] of CORRUPT) {
  for (const form of ["", "long_", "strong_"]) {
    const src = `${form}potion_${from}`;
    if (!BY_KEY.has(src)) continue;
    const dst = BY_KEY.has(`${form}potion_${to}`) ? `${form}potion_${to}` : `potion_${to}`;
    brew(src, "fermented_spider_eye", dst);
  }
}

const BREW_MAP = new Map(BREWS.map(([from, ing, to]) => [`${from}|${ing}`, to]));

/**
 * What an ingredient does to one bottle, by item names: the new item's name,
 * or undefined when it does nothing. Gunpowder turns any potion into its splash form.
 */
export function brewResult(bottle: string, ingredient: string): string | undefined {
  const p = potionOfItem(bottle);
  if (!p) return undefined;
  if (ingredient === "gunpowder") return p.splash ? undefined : `splash_${p.potion.key}`;
  const to = BREW_MAP.get(`${p.potion.key}|${ingredient}`);
  if (!to) return undefined;
  return p.splash ? `splash_${to}` : to;
}

/** Every ingredient the stand accepts, so the slot can refuse anything else. */
export const BREWING_INGREDIENTS: ReadonlySet<string> = new Set(["gunpowder", ...BREWS.map(([, i]) => i)]);
