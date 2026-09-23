/**
 * The item registry.
 *
 * Every placeable block is also an item with the same id (0-255). Items that
 * are not blocks start at 256. Like the block list, ids here are saved in
 * inventories and chests and sent to other players, so the list is
 * append-only.
 *
 * Numbers follow the original game's published values (tool speeds and
 * durability, armour points, food and saturation) so the game feels the way a
 * player's hands already expect: a stone pickaxe takes as long on iron ore as
 * they remember, and a steak fills the same number of shanks.
 */
import { allBlocks, B, block, type Drop, type ToolType } from "./blocks";

export interface ToolInfo {
  type: ToolType;
  /** 0 wood/gold, 1 stone, 2 iron, 3 diamond. */
  tier: number;
  /** Mining speed multiplier against blocks this tool is for. */
  speed: number;
}

export interface FoodInfo {
  hunger: number;
  saturation: number;
  alwaysEdible?: boolean;
  /** Side effect: [effect, seconds, chance]. */
  effect?: [StatusEffect, number, number];
  /** Item left behind (the bowl after stew). */
  remainder?: string;
}

export type StatusEffect = "regeneration" | "hunger" | "poison" | "absorption" | "speed" | "night_vision";

export interface ArmorInfo {
  /** 0 head, 1 chest, 2 legs, 3 feet. */
  slot: 0 | 1 | 2 | 3;
  points: number;
  toughness: number;
  material: "leather" | "iron" | "golden" | "diamond";
}

export type ItemUse =
  | "bucket" | "water_bucket" | "lava_bucket" | "milk_bucket" | "bow" | "flint_and_steel"
  | "bone_meal" | "throw" | "shears" | "hoe" | "plant";

export type Category = "building" | "colored" | "natural" | "functional" | "redstone" | "tools" | "combat" | "food" | "ingredients";

export interface ItemDef {
  id: number;
  name: string;
  displayName: string;
  maxStack: number;
  /** The block this item places, if any. */
  places?: number;
  /** Texture name drawn flat as the icon; undefined means render the block as a cube. */
  icon?: string;
  tool?: ToolInfo;
  /** Melee damage in half-hearts. */
  damage: number;
  /** Swings per second at full strength. */
  attackSpeed: number;
  durability?: number;
  food?: FoodInfo;
  armor?: ArmorInfo;
  /** Burn time in ticks when used as furnace fuel. */
  fuel?: number;
  use?: ItemUse;
  category: Category;
  hidden?: boolean;
}

const ITEMS: ItemDef[] = [];
const BY_NAME = new Map<string, ItemDef>();

function add(def: Partial<ItemDef> & { id: number; name: string; displayName: string }): ItemDef {
  if (ITEMS[def.id]) throw new Error(`item id ${def.id} used twice (${ITEMS[def.id].name}, ${def.name})`);
  const full: ItemDef = {
    maxStack: 64,
    damage: 1,
    attackSpeed: 4,
    category: "ingredients",
    icon: def.name,
    ...def,
  };
  ITEMS[def.id] = full;
  BY_NAME.set(full.name, full);
  return full;
}

// ---- block items -----------------------------------------------------------

/** Blocks whose item is drawn flat, the way they read in a hand, not as a cube. */
const FLAT_BLOCK_ICONS: Record<string, string> = {
  torch: "torch", ladder: "ladder", lantern: "lantern_item", cobweb: "cobweb", lily_pad: "lily_pad",
  glass_pane: "glass", redstone_torch: "redstone_torch", lever: "lever_item", stone_button: "button_item_stone",
  oak_button: "button_item_oak", stone_pressure_plate: "plate_item_stone", oak_pressure_plate: "plate_item_oak",
  repeater: "repeater", comparator: "comparator", hopper: "hopper_item", daylight_detector: "daylight_detector_item",
};
const REDSTONE = new Set([
  "redstone_torch", "lever", "stone_button", "oak_button", "stone_pressure_plate", "oak_pressure_plate", "redstone_lamp",
  "repeater", "comparator", "piston", "sticky_piston", "observer", "daylight_detector", "hopper", "dispenser", "dropper",
  "oak_trapdoor", "iron_trapdoor", "slime_block", "redstone_block", "tnt", "note_block",
]);

const COLORED = /_wool$|terracotta$/;
const NATURAL = new Set([
  "grass_block", "dirt", "stone", "sand", "gravel", "red_sand", "clay", "snow_block", "snow", "ice",
  "packed_ice", "podzol", "coarse_dirt", "mud", "moss_block", "deepslate", "granite", "diorite",
  "andesite", "calcite", "tuff", "bedrock", "obsidian", "pumpkin", "melon", "cactus", "sugar_cane",
  "dead_bush", "short_grass", "fern", "brown_mushroom", "red_mushroom", "lily_pad", "cobweb",
  "amethyst_block",
]);
const FUNCTIONAL = new Set([
  "crafting_table", "furnace", "chest", "torch", "lantern", "ladder", "tnt", "bookshelf", "glowstone",
  "sea_lantern", "jack_o_lantern", "carved_pumpkin", "note_block", "hay_block", "oak_fence", "glass_pane",
]);

for (const def of allBlocks()) {
  if (def.hidden || def.id === 0) continue;
  const flat = FLAT_BLOCK_ICONS[def.name] ?? (def.shape === "cross" ? def.textures.side : undefined);
  const woodBurns = def.material === "wood" && def.flammable;
  const category: Category = REDSTONE.has(def.name)
    ? "redstone"
    : COLORED.test(def.name)
    ? "colored"
    : NATURAL.has(def.name) || /_ore$|_log$|_leaves$|_sapling$/.test(def.name) || def.shape === "cross"
      ? "natural"
      : FUNCTIONAL.has(def.name)
        ? "functional"
        : "building";
  add({
    id: def.id,
    name: def.name,
    displayName: def.displayName,
    places: def.id,
    icon: flat,
    fuel: def.id === B.COAL_BLOCK ? 16000 : def.name.endsWith("_sapling") ? 100 : def.name.endsWith("_wool") ? 100
      : woodBurns || def.id === B.CRAFTING_TABLE || def.id === B.BOOKSHELF || def.id === B.CHEST || def.id === B.OAK_SLAB
        ? (def.id === B.OAK_SLAB ? 150 : 300) : undefined,
    category,
  });
}

// ---- materials ---------------------------------------------------------------

let next = 256;
const item = (name: string, displayName: string, opts: Partial<ItemDef> = {}) =>
  add({ id: next++, name, displayName, ...opts });

item("stick", "Stick", { fuel: 100 });
item("coal", "Coal", { fuel: 1600 });
item("charcoal", "Charcoal", { fuel: 1600 });
item("raw_iron", "Raw Iron");
item("raw_gold", "Raw Gold");
item("raw_copper", "Raw Copper");
item("iron_ingot", "Iron Ingot");
item("gold_ingot", "Gold Ingot");
item("copper_ingot", "Copper Ingot");
item("diamond", "Diamond");
item("emerald", "Emerald");
item("lapis_lazuli", "Lapis Lazuli");
item("redstone", "Redstone Dust", { places: B.REDSTONE_WIRE, category: "redstone" });
item("flint", "Flint");
item("feather", "Feather");
item("string", "String");
item("bone", "Bone");
item("bone_meal", "Bone Meal", { use: "bone_meal" });
item("gunpowder", "Gunpowder");
item("leather", "Leather");
item("clay_ball", "Clay Ball");
item("brick", "Brick");
item("paper", "Paper");
item("book", "Book");
item("sugar", "Sugar");
item("wheat", "Wheat");
item("wheat_seeds", "Wheat Seeds", { places: B.WHEAT, use: "plant" });
item("egg", "Egg", { maxStack: 16, use: "throw" });
item("snowball", "Snowball", { maxStack: 16, use: "throw" });
item("rotten_flesh", "Rotten Flesh", { category: "food", food: { hunger: 4, saturation: 0.8, effect: ["hunger", 30, 0.8] } });
item("spider_eye", "Spider Eye", { category: "food", food: { hunger: 2, saturation: 3.2, effect: ["poison", 5, 1] } });
item("glowstone_dust", "Glowstone Dust");

// ---- food ----------------------------------------------------------------------

const food = (name: string, displayName: string, hunger: number, saturation: number, extra: Partial<FoodInfo> = {}, opts: Partial<ItemDef> = {}) =>
  item(name, displayName, { category: "food", food: { hunger, saturation, ...extra }, ...opts });

food("apple", "Apple", 4, 2.4);
food("golden_apple", "Golden Apple", 4, 9.6, { alwaysEdible: true, effect: ["regeneration", 5, 1] });
food("bread", "Bread", 5, 6);
food("porkchop", "Raw Porkchop", 3, 1.8);
food("cooked_porkchop", "Cooked Porkchop", 8, 12.8);
food("beef", "Raw Beef", 3, 1.8);
food("cooked_beef", "Steak", 8, 12.8);
food("chicken", "Raw Chicken", 2, 1.2, { effect: ["hunger", 30, 0.3] });
food("cooked_chicken", "Cooked Chicken", 6, 7.2);
food("mutton", "Raw Mutton", 2, 1.2);
food("cooked_mutton", "Cooked Mutton", 6, 9.6);
food("carrot", "Carrot", 3, 3.6, {}, { places: B.CARROTS, use: "plant" });
food("potato", "Potato", 1, 0.6, {}, { places: B.POTATOES, use: "plant" });
food("baked_potato", "Baked Potato", 5, 6);
food("melon_slice", "Melon Slice", 2, 1.2);
food("pumpkin_pie", "Pumpkin Pie", 8, 4.8);
item("bowl", "Bowl", { fuel: 100 });
food("mushroom_stew", "Mushroom Stew", 6, 7.2, { remainder: "bowl" }, { maxStack: 1 });

// ---- functional ------------------------------------------------------------------

item("bucket", "Bucket", { maxStack: 16, use: "bucket", category: "tools" });
item("water_bucket", "Water Bucket", { maxStack: 1, use: "water_bucket", category: "tools" });
item("lava_bucket", "Lava Bucket", { maxStack: 1, use: "lava_bucket", fuel: 20000, category: "tools" });
item("milk_bucket", "Milk Bucket", { maxStack: 1, use: "milk_bucket", category: "food" });
item("bow", "Bow", { maxStack: 1, use: "bow", durability: 384, category: "combat" });
item("arrow", "Arrow", { category: "combat" });
item("flint_and_steel", "Flint and Steel", { maxStack: 1, use: "flint_and_steel", durability: 64, category: "tools" });
item("shears", "Shears", { maxStack: 1, use: "shears", durability: 238, tool: { type: "shears", tier: 0, speed: 1.5 }, category: "tools" });
item("oak_door", "Oak Door", { places: B.OAK_DOOR, category: "building", fuel: 200 });
item("red_bed", "Red Bed", { places: B.RED_BED, maxStack: 1, category: "functional" });

export const DYES = ["white", "red", "yellow", "blue", "green", "orange", "purple", "black"] as const;
for (const dye of DYES) {
  item(`${dye}_dye`, `${dye[0].toUpperCase()}${dye.slice(1)} Dye`, { category: "ingredients" });
}

item("iron_nugget", "Iron Nugget");
item("gold_nugget", "Gold Nugget");
if (next > 340) throw new Error("item ids before the tool block overflowed into it");

// ---- tools -------------------------------------------------------------------------

export const TIERS = [
  { key: "wooden", name: "Wooden", tier: 0, speed: 2, durability: 59, bonus: 0 },
  { key: "stone", name: "Stone", tier: 1, speed: 4, durability: 131, bonus: 1 },
  { key: "iron", name: "Iron", tier: 2, speed: 6, durability: 250, bonus: 2 },
  { key: "golden", name: "Golden", tier: 0, speed: 12, durability: 32, bonus: 0 },
  { key: "diamond", name: "Diamond", tier: 3, speed: 8, durability: 1561, bonus: 3 },
] as const;

next = 340;
const SWORD_DAMAGE = [4, 5, 6, 4, 7];
const AXE_DAMAGE = [7, 9, 9, 7, 9];
const AXE_SPEED = [0.8, 0.8, 0.9, 1, 1];
TIERS.forEach((t, i) => {
  const fuel = t.key === "wooden" ? 200 : undefined;
  item(`${t.key}_sword`, `${t.name} Sword`, {
    maxStack: 1, durability: t.durability, damage: SWORD_DAMAGE[i], attackSpeed: 1.6, fuel, category: "combat",
    tool: { type: "sword", tier: t.tier, speed: 1.5 },
  });
  item(`${t.key}_shovel`, `${t.name} Shovel`, {
    maxStack: 1, durability: t.durability, damage: 2.5 + t.bonus, attackSpeed: 1, fuel, category: "tools",
    tool: { type: "shovel", tier: t.tier, speed: t.speed },
  });
  item(`${t.key}_pickaxe`, `${t.name} Pickaxe`, {
    maxStack: 1, durability: t.durability, damage: 2 + t.bonus, attackSpeed: 1.2, fuel, category: "tools",
    tool: { type: "pickaxe", tier: t.tier, speed: t.speed },
  });
  item(`${t.key}_axe`, `${t.name} Axe`, {
    maxStack: 1, durability: t.durability, damage: AXE_DAMAGE[i], attackSpeed: AXE_SPEED[i], fuel, category: "tools",
    tool: { type: "axe", tier: t.tier, speed: t.speed },
  });
  item(`${t.key}_hoe`, `${t.name} Hoe`, {
    maxStack: 1, durability: t.durability, damage: 1, attackSpeed: 1 + t.bonus, fuel, use: "hoe", category: "tools",
    tool: { type: "hoe", tier: t.tier, speed: t.speed },
  });
});

// ---- armour ------------------------------------------------------------------------

next = 380;
const ARMOR = [
  { key: "leather", name: "Leather", points: [1, 3, 2, 1], toughness: 0, mult: 5 },
  { key: "iron", name: "Iron", points: [2, 6, 5, 2], toughness: 0, mult: 15 },
  { key: "golden", name: "Golden", points: [2, 5, 3, 1], toughness: 0, mult: 7 },
  { key: "diamond", name: "Diamond", points: [3, 8, 6, 3], toughness: 2, mult: 33 },
] as const;
const PIECES = [
  { key: "helmet", name: "Cap", base: 11 },
  { key: "chestplate", name: "Tunic", base: 16 },
  { key: "leggings", name: "Pants", base: 15 },
  { key: "boots", name: "Boots", base: 13 },
] as const;
const PIECE_NAMES = ["Helmet", "Chestplate", "Leggings", "Boots"];
for (const a of ARMOR) {
  PIECES.forEach((p, slot) => {
    const display = a.key === "leather" ? `Leather ${p.name}` : `${a.name} ${PIECE_NAMES[slot]}`;
    item(`${a.key}_${p.key}`, display, {
      maxStack: 1, durability: p.base * a.mult, category: "combat",
      armor: { slot: slot as 0 | 1 | 2 | 3, points: a.points[slot], toughness: a.toughness, material: a.key },
    });
  });
}

// ---- redstone and later additions (400+) -----------------------------------------------

next = 400;
item("iron_door", "Iron Door", { places: B.IRON_DOOR, category: "redstone" });
item("slime_ball", "Slimeball");
item("quartz", "Nether Quartz");

// ---- lookups -----------------------------------------------------------------------

export function itemDef(id: number): ItemDef | undefined {
  return ITEMS[id];
}
export function itemByName(name: string): ItemDef {
  const def = BY_NAME.get(name);
  if (!def) throw new Error(`unknown item ${name}`);
  return def;
}
export function itemId(name: string): number {
  return itemByName(name).id;
}
export function allItems(): readonly ItemDef[] {
  return ITEMS.filter(Boolean);
}
export function isItem(id: number): boolean {
  return ITEMS[id] !== undefined;
}

export interface ItemStack {
  id: number;
  count: number;
  /** Uses spent, for items with durability. */
  damage?: number;
}

export function maxStack(id: number): number {
  return ITEMS[id]?.maxStack ?? 64;
}

export function displayName(id: number): string {
  return ITEMS[id]?.displayName ?? block(id).displayName;
}

/** The item a block drops when broken by hand or tool, resolved from its drop table. */
export function resolveDrops(drops: Drop[] | undefined, blockId: number, random: () => number): ItemStack[] {
  if (drops === undefined) return isItem(blockId) ? [{ id: blockId, count: 1 }] : [];
  const out: ItemStack[] = [];
  let chanceTaken = false;
  for (const d of drops) {
    if (d.chance !== undefined) {
      // Chance-gated entries in one table are alternatives, the way gravel
      // drops flint *or* itself — rolling each independently would sometimes
      // give both and sometimes neither.
      if (chanceTaken || random() >= d.chance) continue;
      chanceTaken = true;
    }
    const count = d.min + Math.floor(random() * (d.max - d.min + 1));
    if (count > 0) out.push({ id: itemId(d.item), count });
  }
  return out;
}
