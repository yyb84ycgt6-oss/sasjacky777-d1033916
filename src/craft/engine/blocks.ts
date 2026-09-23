/**
 * The block registry.
 *
 * IDs are stored in saved worlds and sent over the wire, so this list is
 * APPEND-ONLY: never reorder, never delete, never reuse a number. A block that
 * is retired keeps its slot. Reordering would turn every saved house into a
 * different house on next load, and nothing would report it.
 *
 * Every other system reads from here rather than keeping its own notion of a
 * block — the mesher (shape, textures, render layer), physics (collision
 * boxes), lighting (emission, opacity), mining (hardness, tool, harvest tier),
 * audio (material). One table means a new block is one entry, not six edits.
 */

/** Face order used everywhere: +x, -x, +y, -y, +z, -z. */
export const Face = { East: 0, West: 1, Up: 2, Down: 3, South: 4, North: 5 } as const;
export type FaceIndex = (typeof Face)[keyof typeof Face];

export const FACE_DIRS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Horizontal facing stored in block meta: 0 north(-z), 1 south(+z), 2 west(-x), 3 east(+x). */
export const FACING_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [0, 1],
  [-1, 0],
  [1, 0],
];
export const FACING_TO_FACE = [Face.North, Face.South, Face.West, Face.East] as const;
export const OPPOSITE_FACING = [1, 0, 3, 2] as const;
/** Clockwise rotation of a facing seen from above: north → east → south → west. */
export const CLOCKWISE_FACING = [3, 2, 0, 1] as const;

export type Shape = "none" | "cube" | "cross" | "crop" | "boxes" | "fluid";
export type RenderLayer = "none" | "opaque" | "cutout" | "translucent";
export type ToolType = "pickaxe" | "axe" | "shovel" | "hoe" | "sword" | "shears";
export type Material =
  | "stone" | "wood" | "dirt" | "grass" | "sand" | "gravel" | "glass" | "wool"
  | "metal" | "plant" | "leaves" | "snow" | "water" | "lava" | "none";
export type Tint = "none" | "grass" | "foliage" | "birch" | "spruce" | "water";

/** An axis-aligned box inside the block, in sixteenths: [x0, y0, z0, x1, y1, z1]. */
export type Box = readonly [number, number, number, number, number, number];
export const FULL_BOX: Box = [0, 0, 0, 16, 16, 16];

export interface FaceTextures {
  top: string;
  bottom: string;
  side: string;
  /** The face the block looks out of — furnace mouth, pumpkin face. Uses meta facing. */
  front?: string;
}

export interface Drop {
  /** Item name, resolved by the item registry — names, not numbers, so a drop table reads as what it drops. */
  item: string;
  min: number;
  max: number;
  chance?: number;
}

export interface BlockDef {
  id: number;
  name: string;
  displayName: string;
  shape: Shape;
  layer: RenderLayer;
  textures: FaceTextures;
  /** Collides with entities. */
  solid: boolean;
  /** Full opaque cube: hides neighbour faces and blocks light completely. */
  opaque: boolean;
  /** Extra light lost passing through (leaves, water). Opaque blocks stop it entirely. */
  lightFilter: number;
  emission: number;
  /** Seconds-ish, as the original's hardness; -1 cannot be broken. */
  hardness: number;
  tool?: ToolType;
  /** Minimum tool tier to get drops: 0 wood/gold, 1 stone, 2 iron, 3 diamond. */
  harvestTier?: number;
  material: Material;
  /** Placing a block into this cell replaces it (air, tall grass, water). */
  replaceable: boolean;
  gravity: boolean;
  climbable: boolean;
  /** Breaks when the block it rests on is removed. */
  needsSupport: boolean;
  tint: Tint;
  /** Animate in the wind (leaves, grass, flowers). */
  waves: boolean;
  /** Drops when mined with the right tool. Undefined: drops itself. Empty array: drops nothing. */
  drops?: Drop[];
  /** Experience dropped on mining, [min, max]. */
  xp?: [number, number];
  /** Returns the model boxes for a given meta (shape "boxes"). */
  boxes?: (meta: number) => Box[];
  /** Collision boxes; defaults to the model boxes for solid blocks, a full cube for solid cubes. */
  collision?: (meta: number) => Box[];
  /** Places with a horizontal facing taken from the player. */
  facing?: "player" | "away" | "wall";
  /** Has an inventory or a screen. */
  interact?: "crafting" | "furnace" | "chest" | "bed" | "door" | "tnt" | "noteblock";
  flammable?: boolean;
  /** Hidden from the creative inventory (technical blocks). */
  hidden?: boolean;
  /** Friction multiplier for ice. */
  slipperiness?: number;
  /** Walking speed multiplier (soul sand style). */
  speedFactor?: number;
}

type Partial2<T> = { [K in keyof T]?: T[K] };

const BLOCKS: BlockDef[] = [];
const BY_NAME = new Map<string, BlockDef>();

function tex(all: string): FaceTextures;
function tex(top: string, side: string, bottom?: string): FaceTextures;
function tex(a: string, b?: string, c?: string): FaceTextures {
  if (b === undefined) return { top: a, bottom: a, side: a };
  return { top: a, side: b, bottom: c ?? a };
}

function add(id: number, name: string, displayName: string, opts: Partial2<BlockDef> = {}): BlockDef {
  if (BLOCKS[id]) throw new Error(`block id ${id} used twice (${BLOCKS[id].name}, ${name})`);
  const shape = opts.shape ?? "cube";
  const def: BlockDef = {
    id,
    name,
    displayName,
    shape,
    layer: opts.layer ?? (shape === "none" ? "none" : "opaque"),
    textures: opts.textures ?? tex(name),
    solid: opts.solid ?? shape !== "none",
    opaque: opts.opaque ?? (shape === "cube" && (opts.layer ?? "opaque") === "opaque"),
    lightFilter: opts.lightFilter ?? 0,
    emission: opts.emission ?? 0,
    hardness: opts.hardness ?? 1,
    material: opts.material ?? "stone",
    replaceable: opts.replaceable ?? false,
    gravity: opts.gravity ?? false,
    climbable: opts.climbable ?? false,
    needsSupport: opts.needsSupport ?? false,
    tint: opts.tint ?? "none",
    waves: opts.waves ?? false,
    ...opts,
  } as BlockDef;
  BLOCKS[id] = def;
  BY_NAME.set(name, def);
  return def;
}

// ---- shape helpers -------------------------------------------------------

const plant = (hardness = 0): Partial2<BlockDef> => ({
  shape: "cross", layer: "cutout", solid: false, opaque: false, hardness, material: "plant",
  replaceable: false, needsSupport: true, waves: true,
});

const slabBoxes = (meta: number): Box[] =>
  meta === 2 ? [FULL_BOX] : meta === 1 ? [[0, 8, 0, 16, 16, 16]] : [[0, 0, 0, 16, 8, 16]];

/** Stairs: meta bits 0-1 facing (the high side), bit 2 upside down. */
export function stairBoxes(meta: number): Box[] {
  const facing = meta & 3;
  const upside = (meta & 4) !== 0;
  const base: Box = upside ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16];
  const y0 = upside ? 0 : 8, y1 = upside ? 8 : 16;
  const step: Box =
    facing === 0 ? [0, y0, 0, 16, y1, 8] :
    facing === 1 ? [0, y0, 8, 16, y1, 16] :
    facing === 2 ? [0, y0, 0, 8, y1, 16] :
                   [8, y0, 0, 16, y1, 16];
  return [base, step];
}

function panelBox(side: number, thickness: number): Box {
  const t = thickness;
  return side === 0 ? [0, 0, 0, 16, 16, t] :
         side === 1 ? [0, 0, 16 - t, 16, 16, 16] :
         side === 2 ? [0, 0, 0, t, 16, 16] :
                      [16 - t, 0, 0, 16, 16, 16];
}

/** Door meta: bits 0-1 facing, bit 2 open, bit 3 upper half, bit 4 hinge on the right. */
export function doorBoxes(meta: number): Box[] {
  const facing = meta & 3;
  const open = (meta & 4) !== 0;
  const hingeRight = (meta & 16) !== 0;
  let side = facing;
  if (open) {
    side = hingeRight ? CLOCKWISE_FACING[CLOCKWISE_FACING[CLOCKWISE_FACING[facing]]] : CLOCKWISE_FACING[facing];
  }
  return [panelBox(side, 3)];
}

/** Ladder meta: the facing of the wall it hangs on (panel sits against that wall). */
const ladderBoxes = (meta: number): Box[] => [panelBox(meta & 3, 1)];

/** Torch meta: 0 standing, 1..4 on a wall (1 + facing of the wall). */
export function torchBoxes(meta: number): Box[] {
  if (meta === 0) return [[7, 0, 7, 9, 10, 9]];
  const f = (meta - 1) & 3;
  const [dx, dz] = FACING_DIRS[f];
  const ox = 7 + dx * 6, oz = 7 + dz * 6;
  return [[ox, 3, oz, ox + 2, 13, oz + 2]];
}

// ---- the list (append-only) ----------------------------------------------

const P = "pickaxe", A = "axe", S = "shovel", H = "hoe";

add(0, "air", "Air", { shape: "none", solid: false, opaque: false, replaceable: true, material: "none", hardness: 0, hidden: true, drops: [] });
add(1, "stone", "Stone", { hardness: 1.5, tool: P, harvestTier: 0, drops: [{ item: "cobblestone", min: 1, max: 1 }] });
add(2, "grass_block", "Grass Block", {
  textures: tex("grass_block_top", "grass_block_side", "dirt"), hardness: 0.6, tool: S, material: "grass",
  tint: "grass", drops: [{ item: "dirt", min: 1, max: 1 }],
});
add(3, "dirt", "Dirt", { hardness: 0.5, tool: S, material: "dirt" });
add(4, "cobblestone", "Cobblestone", { hardness: 2, tool: P, harvestTier: 0 });
add(5, "oak_planks", "Oak Planks", { hardness: 2, tool: A, material: "wood", flammable: true });
add(6, "bedrock", "Bedrock", { hardness: -1, drops: [] });
add(7, "water", "Water", {
  shape: "fluid", layer: "translucent", solid: false, opaque: false, replaceable: true, lightFilter: 2,
  hardness: -1, material: "water", textures: tex("water_still"), tint: "water", drops: [], hidden: true,
});
add(8, "lava", "Lava", {
  shape: "fluid", layer: "opaque", solid: false, opaque: false, replaceable: true, emission: 15,
  hardness: -1, material: "lava", textures: tex("lava_still"), drops: [], hidden: true,
});
add(9, "sand", "Sand", { hardness: 0.5, tool: S, material: "sand", gravity: true });
add(10, "gravel", "Gravel", {
  hardness: 0.6, tool: S, material: "gravel", gravity: true,
  drops: [{ item: "flint", min: 1, max: 1, chance: 0.1 }, { item: "gravel", min: 1, max: 1, chance: 1 }],
});
add(11, "oak_log", "Oak Log", { textures: tex("oak_log_top", "oak_log"), hardness: 2, tool: A, material: "wood", flammable: true });
add(12, "oak_leaves", "Oak Leaves", {
  layer: "cutout", opaque: false, lightFilter: 1, hardness: 0.2, tool: "shears", material: "leaves",
  tint: "foliage", waves: true, flammable: true,
  drops: [{ item: "oak_sapling", min: 1, max: 1, chance: 0.05 }, { item: "apple", min: 1, max: 1, chance: 0.02 }, { item: "stick", min: 1, max: 2, chance: 0.04 }],
});
add(13, "glass", "Glass", { layer: "cutout", opaque: false, hardness: 0.3, material: "glass", drops: [] });
add(14, "coal_ore", "Coal Ore", { hardness: 3, tool: P, harvestTier: 0, drops: [{ item: "coal", min: 1, max: 1 }], xp: [0, 2] });
add(15, "iron_ore", "Iron Ore", { hardness: 3, tool: P, harvestTier: 1, drops: [{ item: "raw_iron", min: 1, max: 1 }] });
add(16, "gold_ore", "Gold Ore", { hardness: 3, tool: P, harvestTier: 2, drops: [{ item: "raw_gold", min: 1, max: 1 }] });
add(17, "diamond_ore", "Diamond Ore", { hardness: 3, tool: P, harvestTier: 2, drops: [{ item: "diamond", min: 1, max: 1 }], xp: [3, 7] });
add(18, "redstone_ore", "Redstone Ore", { hardness: 3, tool: P, harvestTier: 2, drops: [{ item: "redstone", min: 4, max: 5 }], xp: [1, 5] });
add(19, "lapis_ore", "Lapis Lazuli Ore", { hardness: 3, tool: P, harvestTier: 1, drops: [{ item: "lapis_lazuli", min: 4, max: 9 }], xp: [2, 5] });
add(20, "emerald_ore", "Emerald Ore", { hardness: 3, tool: P, harvestTier: 2, drops: [{ item: "emerald", min: 1, max: 1 }], xp: [3, 7] });
add(21, "copper_ore", "Copper Ore", { hardness: 3, tool: P, harvestTier: 1, drops: [{ item: "raw_copper", min: 2, max: 5 }] });
add(22, "deepslate", "Deepslate", { textures: tex("deepslate_top", "deepslate"), hardness: 3, tool: P, harvestTier: 0, drops: [{ item: "cobbled_deepslate", min: 1, max: 1 }] });
add(23, "cobbled_deepslate", "Cobbled Deepslate", { hardness: 3.5, tool: P, harvestTier: 0 });
add(24, "deepslate_iron_ore", "Deepslate Iron Ore", { hardness: 4.5, tool: P, harvestTier: 1, drops: [{ item: "raw_iron", min: 1, max: 1 }] });
add(25, "deepslate_gold_ore", "Deepslate Gold Ore", { hardness: 4.5, tool: P, harvestTier: 2, drops: [{ item: "raw_gold", min: 1, max: 1 }] });
add(26, "deepslate_diamond_ore", "Deepslate Diamond Ore", { hardness: 4.5, tool: P, harvestTier: 2, drops: [{ item: "diamond", min: 1, max: 1 }], xp: [3, 7] });
add(27, "deepslate_redstone_ore", "Deepslate Redstone Ore", { hardness: 4.5, tool: P, harvestTier: 2, drops: [{ item: "redstone", min: 4, max: 5 }], xp: [1, 5] });
add(28, "deepslate_lapis_ore", "Deepslate Lapis Ore", { hardness: 4.5, tool: P, harvestTier: 1, drops: [{ item: "lapis_lazuli", min: 4, max: 9 }], xp: [2, 5] });
add(29, "deepslate_coal_ore", "Deepslate Coal Ore", { hardness: 4.5, tool: P, harvestTier: 0, drops: [{ item: "coal", min: 1, max: 1 }], xp: [0, 2] });

add(30, "birch_log", "Birch Log", { textures: tex("birch_log_top", "birch_log"), hardness: 2, tool: A, material: "wood", flammable: true });
add(31, "birch_leaves", "Birch Leaves", {
  layer: "cutout", opaque: false, lightFilter: 1, hardness: 0.2, tool: "shears", material: "leaves", tint: "birch", waves: true,
  drops: [{ item: "birch_sapling", min: 1, max: 1, chance: 0.05 }, { item: "stick", min: 1, max: 2, chance: 0.04 }],
});
add(32, "birch_planks", "Birch Planks", { hardness: 2, tool: A, material: "wood", flammable: true });
add(33, "spruce_log", "Spruce Log", { textures: tex("spruce_log_top", "spruce_log"), hardness: 2, tool: A, material: "wood", flammable: true });
add(34, "spruce_leaves", "Spruce Leaves", {
  layer: "cutout", opaque: false, lightFilter: 1, hardness: 0.2, tool: "shears", material: "leaves", tint: "spruce", waves: true,
  drops: [{ item: "spruce_sapling", min: 1, max: 1, chance: 0.05 }, { item: "stick", min: 1, max: 2, chance: 0.04 }],
});
add(35, "spruce_planks", "Spruce Planks", { hardness: 2, tool: A, material: "wood", flammable: true });
add(36, "jungle_log", "Jungle Log", { textures: tex("jungle_log_top", "jungle_log"), hardness: 2, tool: A, material: "wood", flammable: true });
add(37, "jungle_leaves", "Jungle Leaves", {
  layer: "cutout", opaque: false, lightFilter: 1, hardness: 0.2, tool: "shears", material: "leaves", tint: "foliage", waves: true,
  drops: [{ item: "jungle_sapling", min: 1, max: 1, chance: 0.025 }, { item: "stick", min: 1, max: 2, chance: 0.04 }],
});
add(38, "jungle_planks", "Jungle Planks", { hardness: 2, tool: A, material: "wood", flammable: true });
add(39, "acacia_log", "Acacia Log", { textures: tex("acacia_log_top", "acacia_log"), hardness: 2, tool: A, material: "wood", flammable: true });
add(40, "acacia_leaves", "Acacia Leaves", {
  layer: "cutout", opaque: false, lightFilter: 1, hardness: 0.2, tool: "shears", material: "leaves", tint: "foliage", waves: true,
  drops: [{ item: "acacia_sapling", min: 1, max: 1, chance: 0.05 }, { item: "stick", min: 1, max: 2, chance: 0.04 }],
});
add(41, "acacia_planks", "Acacia Planks", { hardness: 2, tool: A, material: "wood", flammable: true });

add(42, "sandstone", "Sandstone", { textures: tex("sandstone_top", "sandstone", "sandstone_bottom"), hardness: 0.8, tool: P, harvestTier: 0 });
add(43, "red_sand", "Red Sand", { hardness: 0.5, tool: S, material: "sand", gravity: true });
add(44, "terracotta", "Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(45, "orange_terracotta", "Orange Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(46, "yellow_terracotta", "Yellow Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(47, "red_terracotta", "Red Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(48, "brown_terracotta", "Brown Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(49, "white_terracotta", "White Terracotta", { hardness: 1.25, tool: P, harvestTier: 0 });
add(50, "snow_block", "Snow Block", { textures: tex("snow"), hardness: 0.2, tool: S, material: "snow", drops: [{ item: "snowball", min: 4, max: 4 }] });
add(51, "snow", "Snow", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[0, 0, 0, 16, 2, 16]], collision: () => [],
  hardness: 0.1, tool: S, material: "snow", replaceable: true, needsSupport: true, textures: tex("snow"),
  drops: [{ item: "snowball", min: 1, max: 1 }],
});
add(52, "ice", "Ice", { layer: "translucent", opaque: false, lightFilter: 2, hardness: 0.5, tool: P, material: "glass", drops: [], slipperiness: 0.98 });

add(53, "oak_sapling", "Oak Sapling", plant());
add(54, "birch_sapling", "Birch Sapling", plant());
add(55, "spruce_sapling", "Spruce Sapling", plant());
add(56, "jungle_sapling", "Jungle Sapling", plant());
add(57, "acacia_sapling", "Acacia Sapling", plant());

add(58, "short_grass", "Grass", { ...plant(), replaceable: true, tint: "grass", drops: [{ item: "wheat_seeds", min: 1, max: 1, chance: 0.125 }] });
add(59, "fern", "Fern", { ...plant(), replaceable: true, tint: "grass", drops: [{ item: "wheat_seeds", min: 1, max: 1, chance: 0.125 }] });
add(60, "dead_bush", "Dead Bush", { ...plant(), replaceable: true, waves: false, drops: [{ item: "stick", min: 0, max: 2 }] });
add(61, "dandelion", "Dandelion", plant());
add(62, "poppy", "Poppy", plant());
add(63, "blue_orchid", "Blue Orchid", plant());
add(64, "allium", "Allium", plant());
add(65, "cornflower", "Cornflower", plant());
add(66, "oxeye_daisy", "Oxeye Daisy", plant());
add(67, "red_tulip", "Red Tulip", plant());
add(68, "lily_of_the_valley", "Lily of the Valley", plant());
add(69, "brown_mushroom", "Brown Mushroom", { ...plant(), waves: false, emission: 1 });
add(70, "red_mushroom", "Red Mushroom", { ...plant(), waves: false });
add(71, "sugar_cane", "Sugar Cane", { ...plant(), waves: false, tint: "grass" });
add(72, "cactus", "Cactus", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: () => [[1, 0, 1, 15, 16, 15]],
  collision: () => [[1, 0, 1, 15, 15, 15]],
  textures: tex("cactus_top", "cactus_side", "cactus_bottom"), hardness: 0.4, material: "wool", needsSupport: true,
});

add(73, "clay", "Clay", { hardness: 0.6, tool: S, material: "dirt", drops: [{ item: "clay_ball", min: 4, max: 4 }] });
add(74, "granite", "Granite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(75, "diorite", "Diorite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(76, "andesite", "Andesite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(77, "mossy_cobblestone", "Mossy Cobblestone", { hardness: 2, tool: P, harvestTier: 0 });
add(78, "stone_bricks", "Stone Bricks", { hardness: 1.5, tool: P, harvestTier: 0 });
add(79, "mossy_stone_bricks", "Mossy Stone Bricks", { hardness: 1.5, tool: P, harvestTier: 0 });
add(80, "bricks", "Bricks", { hardness: 2, tool: P, harvestTier: 0 });
add(81, "obsidian", "Obsidian", { hardness: 50, tool: P, harvestTier: 3 });
add(82, "crafting_table", "Crafting Table", {
  textures: { top: "crafting_table_top", side: "crafting_table_side", bottom: "oak_planks", front: "crafting_table_front" },
  hardness: 2.5, tool: A, material: "wood", interact: "crafting", facing: "player",
});
add(83, "furnace", "Furnace", {
  textures: { top: "furnace_top", side: "furnace_side", bottom: "furnace_top", front: "furnace_front" },
  hardness: 3.5, tool: P, harvestTier: 0, interact: "furnace", facing: "player",
});
add(84, "lit_furnace", "Furnace", {
  textures: { top: "furnace_top", side: "furnace_side", bottom: "furnace_top", front: "furnace_front_on" },
  hardness: 3.5, tool: P, harvestTier: 0, interact: "furnace", facing: "player", emission: 13,
  drops: [{ item: "furnace", min: 1, max: 1 }], hidden: true,
});
add(85, "chest", "Chest", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[1, 0, 1, 15, 14, 15]],
  textures: { top: "chest_top", side: "chest_side", bottom: "chest_top", front: "chest_front" },
  hardness: 2.5, tool: A, material: "wood", interact: "chest", facing: "player",
});
add(86, "torch", "Torch", {
  shape: "boxes", layer: "cutout", solid: false, opaque: false, boxes: torchBoxes, collision: () => [],
  textures: tex("torch"), emission: 14, hardness: 0, material: "wood", needsSupport: true, facing: "wall",
});
add(87, "tnt", "TNT", { textures: tex("tnt_top", "tnt_side", "tnt_bottom"), hardness: 0, material: "grass", interact: "tnt" });
add(88, "bookshelf", "Bookshelf", {
  textures: tex("oak_planks", "bookshelf", "oak_planks"), hardness: 1.5, tool: A, material: "wood",
  drops: [{ item: "book", min: 3, max: 3 }],
});
add(89, "glowstone", "Glowstone", { hardness: 0.3, material: "glass", emission: 15, drops: [{ item: "glowstone_dust", min: 2, max: 4 }] });
add(90, "iron_block", "Block of Iron", { hardness: 5, tool: P, harvestTier: 1, material: "metal" });
add(91, "gold_block", "Block of Gold", { hardness: 3, tool: P, harvestTier: 2, material: "metal" });
add(92, "diamond_block", "Block of Diamond", { hardness: 5, tool: P, harvestTier: 2, material: "metal" });
add(93, "emerald_block", "Block of Emerald", { hardness: 5, tool: P, harvestTier: 2, material: "metal" });
add(94, "coal_block", "Block of Coal", { hardness: 5, tool: P, harvestTier: 0 });
add(95, "lapis_block", "Block of Lapis Lazuli", { hardness: 3, tool: P, harvestTier: 1 });
add(96, "redstone_block", "Block of Redstone", { hardness: 5, tool: P, harvestTier: 0, material: "metal" });
add(97, "copper_block", "Block of Copper", { hardness: 3, tool: P, harvestTier: 1, material: "metal" });

export const WOOL_COLORS = [
  "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray",
  "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black",
] as const;
const WOOL_BASE = 98;
WOOL_COLORS.forEach((color, i) => {
  const title = color.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  add(WOOL_BASE + i, `${color}_wool`, `${title} Wool`, { hardness: 0.8, tool: "shears", material: "wool", flammable: true });
});
// 98..113 are wool.

add(114, "pumpkin", "Pumpkin", { textures: tex("pumpkin_top", "pumpkin_side"), hardness: 1, tool: A, material: "wood" });
add(115, "carved_pumpkin", "Carved Pumpkin", {
  textures: { top: "pumpkin_top", side: "pumpkin_side", bottom: "pumpkin_top", front: "carved_pumpkin" },
  hardness: 1, tool: A, material: "wood", facing: "player",
});
add(116, "jack_o_lantern", "Jack o'Lantern", {
  textures: { top: "pumpkin_top", side: "pumpkin_side", bottom: "pumpkin_top", front: "jack_o_lantern" },
  hardness: 1, tool: A, material: "wood", facing: "player", emission: 15,
});
add(117, "melon", "Melon", { textures: tex("melon_top", "melon_side"), hardness: 1, tool: A, material: "wood", drops: [{ item: "melon_slice", min: 3, max: 7 }] });
add(118, "farmland", "Farmland", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[0, 0, 0, 16, 15, 16]],
  textures: tex("farmland", "dirt"), hardness: 0.6, tool: S, material: "dirt", drops: [{ item: "dirt", min: 1, max: 1 }],
});
add(119, "dirt_path", "Dirt Path", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[0, 0, 0, 16, 15, 16]],
  textures: tex("dirt_path_top", "dirt_path_side", "dirt"), hardness: 0.65, tool: S, material: "grass",
  drops: [{ item: "dirt", min: 1, max: 1 }],
});
add(120, "wheat", "Wheat Crops", {
  shape: "crop", layer: "cutout", solid: false, opaque: false, hardness: 0, material: "plant", needsSupport: true,
  textures: tex("wheat_stage_7"), hidden: true, waves: true,
});
add(121, "carrots", "Carrots", {
  shape: "crop", layer: "cutout", solid: false, opaque: false, hardness: 0, material: "plant", needsSupport: true,
  textures: tex("carrots_stage_3"), hidden: true, waves: true,
});
add(122, "potatoes", "Potatoes", {
  shape: "crop", layer: "cutout", solid: false, opaque: false, hardness: 0, material: "plant", needsSupport: true,
  textures: tex("potatoes_stage_3"), hidden: true, waves: true,
});
add(123, "oak_door", "Oak Door", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: doorBoxes,
  textures: tex("oak_door_top"), hardness: 3, tool: A, material: "wood", interact: "door", hidden: true,
  drops: [{ item: "oak_door", min: 1, max: 1 }],
});
add(124, "ladder", "Ladder", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: ladderBoxes, climbable: true,
  textures: tex("ladder"), hardness: 0.4, tool: A, material: "wood", facing: "wall",
});
add(125, "red_bed", "Red Bed", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[0, 0, 0, 16, 9, 16]],
  textures: { top: "bed_foot_top", side: "bed_side", bottom: "oak_planks" },
  hardness: 0.2, material: "wool", interact: "bed", hidden: true, drops: [{ item: "red_bed", min: 1, max: 1 }],
});
add(126, "oak_slab", "Oak Slab", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: slabBoxes, textures: tex("oak_planks"),
  hardness: 2, tool: A, material: "wood",
});
add(127, "cobblestone_slab", "Cobblestone Slab", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: slabBoxes, textures: tex("cobblestone"),
  hardness: 2, tool: P, harvestTier: 0,
});
add(128, "stone_slab", "Stone Slab", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: slabBoxes, textures: tex("stone"),
  hardness: 2, tool: P, harvestTier: 0,
});
add(129, "stone_brick_slab", "Stone Brick Slab", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: slabBoxes, textures: tex("stone_bricks"),
  hardness: 2, tool: P, harvestTier: 0,
});
add(130, "oak_stairs", "Oak Stairs", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: stairBoxes, textures: tex("oak_planks"),
  hardness: 2, tool: A, material: "wood", facing: "away",
});
add(131, "cobblestone_stairs", "Cobblestone Stairs", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: stairBoxes, textures: tex("cobblestone"),
  hardness: 2, tool: P, harvestTier: 0, facing: "away",
});
add(132, "stone_brick_stairs", "Stone Brick Stairs", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: stairBoxes, textures: tex("stone_bricks"),
  hardness: 1.5, tool: P, harvestTier: 0, facing: "away",
});
add(133, "lantern", "Lantern", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: () => [[5, 0, 5, 11, 7, 11], [6, 7, 6, 10, 9, 10]],
  textures: tex("lantern"), emission: 15, hardness: 3.5, tool: P, material: "metal", needsSupport: true,
});
add(134, "hay_block", "Hay Bale", { textures: tex("hay_block_top", "hay_block_side"), hardness: 0.5, tool: H, material: "grass" });
add(135, "lily_pad", "Lily Pad", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: () => [[0, 0, 0, 16, 1, 16]], collision: () => [[1, 0, 1, 15, 1, 15]],
  textures: tex("lily_pad"), hardness: 0, material: "plant", tint: "foliage", needsSupport: true,
});
add(136, "smooth_stone", "Smooth Stone", { textures: tex("smooth_stone"), hardness: 2, tool: P, harvestTier: 0 });
add(137, "sea_lantern", "Sea Lantern", { hardness: 0.3, material: "glass", emission: 15 });
add(138, "packed_ice", "Packed Ice", { hardness: 0.5, tool: P, material: "glass", drops: [], slipperiness: 0.98 });
add(139, "podzol", "Podzol", { textures: tex("podzol_top", "podzol_side", "dirt"), hardness: 0.5, tool: S, material: "dirt", drops: [{ item: "dirt", min: 1, max: 1 }] });
add(140, "coarse_dirt", "Coarse Dirt", { hardness: 0.5, tool: S, material: "dirt" });
add(141, "mud", "Mud", { hardness: 0.5, tool: S, material: "dirt", speedFactor: 0.8 });
add(142, "moss_block", "Moss Block", { hardness: 0.1, tool: H, material: "grass" });
add(143, "amethyst_block", "Block of Amethyst", { hardness: 1.5, tool: P, material: "glass" });
add(144, "cobweb", "Cobweb", {
  shape: "cross", layer: "cutout", solid: false, opaque: false, lightFilter: 1, hardness: 4, tool: "sword",
  material: "wool", speedFactor: 0.25, drops: [{ item: "string", min: 1, max: 1 }],
});
add(145, "oak_fence", "Oak Fence", {
  shape: "boxes", layer: "opaque", opaque: false, boxes: () => [[6, 0, 6, 10, 16, 10]],
  collision: () => [[6, 0, 6, 10, 24, 10]], textures: tex("oak_planks"), hardness: 2, tool: A, material: "wood",
});
add(146, "glass_pane", "Glass Pane", {
  shape: "boxes", layer: "cutout", opaque: false, boxes: () => [[7, 0, 0, 9, 16, 16], [0, 0, 7, 16, 16, 9]],
  textures: tex("glass"), hardness: 0.3, material: "glass", drops: [],
});
add(147, "note_block", "Note Block", { hardness: 0.8, tool: A, material: "wood", interact: "noteblock" });
add(148, "calcite", "Calcite", { hardness: 0.75, tool: P, harvestTier: 0 });
add(149, "tuff", "Tuff", { hardness: 1.5, tool: P, harvestTier: 0 });
add(150, "polished_granite", "Polished Granite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(151, "polished_diorite", "Polished Diorite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(152, "polished_andesite", "Polished Andesite", { hardness: 1.5, tool: P, harvestTier: 0 });
add(153, "chiseled_stone_bricks", "Chiseled Stone Bricks", { hardness: 1.5, tool: P, harvestTier: 0 });
add(154, "cracked_stone_bricks", "Cracked Stone Bricks", { hardness: 1.5, tool: P, harvestTier: 0 });

export const BLOCK_COUNT = BLOCKS.length;

const AIR_DEF = BLOCKS[0];
export function block(id: number): BlockDef {
  return BLOCKS[id] ?? AIR_DEF;
}
export function blockByName(name: string): BlockDef {
  const def = BY_NAME.get(name);
  if (!def) throw new Error(`unknown block ${name}`);
  return def;
}
export function allBlocks(): readonly BlockDef[] {
  return BLOCKS.filter(Boolean);
}

/** Named ids, so generation and game code read as words rather than numbers. */
export const B = {
  AIR: 0, STONE: 1, GRASS: 2, DIRT: 3, COBBLE: 4, OAK_PLANKS: 5, BEDROCK: 6, WATER: 7, LAVA: 8,
  SAND: 9, GRAVEL: 10, OAK_LOG: 11, OAK_LEAVES: 12, GLASS: 13, COAL_ORE: 14, IRON_ORE: 15,
  GOLD_ORE: 16, DIAMOND_ORE: 17, REDSTONE_ORE: 18, LAPIS_ORE: 19, EMERALD_ORE: 20, COPPER_ORE: 21,
  DEEPSLATE: 22, COBBLED_DEEPSLATE: 23, DS_IRON: 24, DS_GOLD: 25, DS_DIAMOND: 26, DS_REDSTONE: 27,
  DS_LAPIS: 28, DS_COAL: 29, BIRCH_LOG: 30, BIRCH_LEAVES: 31, BIRCH_PLANKS: 32, SPRUCE_LOG: 33,
  SPRUCE_LEAVES: 34, SPRUCE_PLANKS: 35, JUNGLE_LOG: 36, JUNGLE_LEAVES: 37, JUNGLE_PLANKS: 38,
  ACACIA_LOG: 39, ACACIA_LEAVES: 40, ACACIA_PLANKS: 41, SANDSTONE: 42, RED_SAND: 43, TERRACOTTA: 44,
  ORANGE_TERRACOTTA: 45, YELLOW_TERRACOTTA: 46, RED_TERRACOTTA: 47, BROWN_TERRACOTTA: 48,
  WHITE_TERRACOTTA: 49, SNOW_BLOCK: 50, SNOW: 51, ICE: 52, OAK_SAPLING: 53, BIRCH_SAPLING: 54,
  SPRUCE_SAPLING: 55, JUNGLE_SAPLING: 56, ACACIA_SAPLING: 57, SHORT_GRASS: 58, FERN: 59,
  DEAD_BUSH: 60, DANDELION: 61, POPPY: 62, BLUE_ORCHID: 63, ALLIUM: 64, CORNFLOWER: 65,
  OXEYE_DAISY: 66, RED_TULIP: 67, LILY_OF_THE_VALLEY: 68, BROWN_MUSHROOM: 69, RED_MUSHROOM: 70,
  SUGAR_CANE: 71, CACTUS: 72, CLAY: 73, GRANITE: 74, DIORITE: 75, ANDESITE: 76, MOSSY_COBBLE: 77,
  STONE_BRICKS: 78, MOSSY_STONE_BRICKS: 79, BRICKS: 80, OBSIDIAN: 81, CRAFTING_TABLE: 82,
  FURNACE: 83, LIT_FURNACE: 84, CHEST: 85, TORCH: 86, TNT: 87, BOOKSHELF: 88, GLOWSTONE: 89,
  IRON_BLOCK: 90, GOLD_BLOCK: 91, DIAMOND_BLOCK: 92, EMERALD_BLOCK: 93, COAL_BLOCK: 94,
  LAPIS_BLOCK: 95, REDSTONE_BLOCK: 96, COPPER_BLOCK: 97, WHITE_WOOL: 98, PUMPKIN: 114,
  CARVED_PUMPKIN: 115, JACK_O_LANTERN: 116, MELON: 117, FARMLAND: 118, DIRT_PATH: 119, WHEAT: 120,
  CARROTS: 121, POTATOES: 122, OAK_DOOR: 123, LADDER: 124, RED_BED: 125, OAK_SLAB: 126,
  COBBLE_SLAB: 127, STONE_SLAB: 128, STONE_BRICK_SLAB: 129, OAK_STAIRS: 130, COBBLE_STAIRS: 131,
  STONE_BRICK_STAIRS: 132, LANTERN: 133, HAY: 134, LILY_PAD: 135, SMOOTH_STONE: 136,
  SEA_LANTERN: 137, PACKED_ICE: 138, PODZOL: 139, COARSE_DIRT: 140, MUD: 141, MOSS: 142,
  AMETHYST: 143, COBWEB: 144, OAK_FENCE: 145, GLASS_PANE: 146, NOTE_BLOCK: 147, CALCITE: 148,
  TUFF: 149,
} as const;

export const isFluid = (id: number): boolean => id === B.WATER || id === B.LAVA;
export const isLog = (id: number): boolean =>
  id === B.OAK_LOG || id === B.BIRCH_LOG || id === B.SPRUCE_LOG || id === B.JUNGLE_LOG || id === B.ACACIA_LOG;
export const isLeaves = (id: number): boolean =>
  id === B.OAK_LEAVES || id === B.BIRCH_LEAVES || id === B.SPRUCE_LEAVES || id === B.JUNGLE_LEAVES || id === B.ACACIA_LEAVES;
export const isCrop = (id: number): boolean => id === B.WHEAT || id === B.CARROTS || id === B.POTATOES;
export const isSapling = (id: number): boolean => id >= B.OAK_SAPLING && id <= B.ACACIA_SAPLING;
export const isSlab = (id: number): boolean => id >= B.OAK_SLAB && id <= B.STONE_BRICK_SLAB;
export const isStairs = (id: number): boolean => id >= B.OAK_STAIRS && id <= B.STONE_BRICK_STAIRS;

/** Maximum growth stage for crops (meta holds the age). */
export const CROP_MAX_AGE: Record<number, number> = { [B.WHEAT]: 7, [B.CARROTS]: 3, [B.POTATOES]: 3 };

/**
 * The texture a given face shows, accounting for facing and log axis.
 * Logs keep their axis in meta (0 up, 1 x, 2 z) so a sideways log shows its
 * rings on the ends rather than bark on every face.
 */
export function faceTexture(def: BlockDef, meta: number, face: number): string {
  const t = def.textures;
  if (isLog(def.id)) {
    const axis = meta & 3;
    const end = axis === 0 ? face === Face.Up || face === Face.Down : axis === 1 ? face === Face.East || face === Face.West : face === Face.South || face === Face.North;
    return end ? t.top : t.side;
  }
  if (def.id === B.OAK_DOOR) return (meta & 8) !== 0 ? "oak_door_top" : "oak_door_bottom";
  if (def.id === B.RED_BED) {
    const head = (meta & 4) !== 0;
    if (face === Face.Up) return head ? "bed_head_top" : "bed_foot_top";
    if (face === Face.Down) return "oak_planks";
    return head ? "bed_head_side" : "bed_side";
  }
  if (isCrop(def.id)) {
    const base = def.id === B.WHEAT ? "wheat" : def.id === B.CARROTS ? "carrots" : "potatoes";
    return `${base}_stage_${meta & 7}`;
  }
  if (face === Face.Up) return t.top;
  if (face === Face.Down) return t.bottom;
  if (t.front && def.facing === "player" && FACING_TO_FACE[meta & 3] === face) return t.front;
  return t.side;
}

/** Model boxes for a block with this meta; a full cube for plain cubes. */
export function modelBoxes(def: BlockDef, meta: number): Box[] {
  if (def.boxes) return def.boxes(meta);
  return [FULL_BOX];
}

/** Boxes an entity collides with. Empty for non-solid blocks. */
export function collisionBoxes(def: BlockDef, meta: number): Box[] {
  if (!def.solid) return [];
  if (def.collision) return def.collision(meta);
  if (def.boxes) return def.boxes(meta);
  return [FULL_BOX];
}
