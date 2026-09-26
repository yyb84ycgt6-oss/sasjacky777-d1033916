/**
 * Game modes: the ways to play a world, from the classics to the minigames
 * that made servers famous — SkyBlock, OneBlock, the Survival Games, wave
 * defence, parkour, TNT Run, UHC, speedruns, lucky blocks — and challenges
 * that bend a normal world (random drops, one heart).
 *
 * A mode is chosen when a world is created and kept in its meta: which map
 * pack it is built on (engine/maps.ts), the game mode and rules it starts
 * with, and what it has kept track of since (`ModeState.data`). What a mode
 * does while it runs lives in its runtime (modes/runtime.ts and the files
 * beside it); this file is only what it is, so the create screen, the tests
 * and a guest can read it without the game.
 */
import type { GameRules, WorldMeta } from "../game/save";
import type { GameMode } from "../engine/player";
import type { MapId } from "../engine/maps";
import type { WorldType } from "../engine/worldgen";

export type ModeCategory = "classic" | "minigame" | "challenge" | "primal" | "zombie";

export const CATEGORY_NAMES: Record<ModeCategory, string> = {
  classic: "Classic", minigame: "Minigames", challenge: "Challenges", primal: "Primal", zombie: "Zombies",
};

export interface ModeDef {
  id: string;
  name: string;
  category: ModeCategory;
  /** Item drawn on its card. */
  icon: string;
  description: string;
  /** What winning (or doing well) looks like, in a line. */
  goal: string;
  /** The game or server tradition it comes from. */
  inspiredBy?: string;
  map?: MapId;
  type?: WorldType;
  gameMode: GameMode;
  difficulty?: 0 | 1 | 2 | 3;
  hardcore?: boolean;
  cheats?: boolean;
  rules?: Partial<GameRules>;
  /** Lucky blocks scattered through the terrain (engine/lucky.ts). */
  lucky?: boolean;
  /** Good with friends; playable alone (bots or a score to beat) either way. */
  multiplayer?: boolean;
  /** Who roams the wilds instead of the overworld's usual mobs: Primal's creatures, or the infected. */
  fauna?: "primal" | "infected";
  /** Primal's rules: Evolved's, or Ascended's gentler taming and wider roster. */
  primal?: "evolved" | "ascended";
  /** Survival beyond hunger: thirst, body temperature, and wounds (bleeding, sickness, broken bones). */
  vitals?: { thirst?: boolean; temperature?: boolean; wounds?: boolean };
  /** Recipes past the stone age are learned, a level at a time (engine/engrams.ts). */
  engrams?: boolean;
}

/** A world's mode and what it has kept track of: counters, times, bests. */
export interface ModeState {
  id: string;
  /** Set once the mode has given its kit and set its stage, so reloading does not do it again. */
  started?: boolean;
  data: Record<string, unknown>;
}

export const MODES: readonly ModeDef[] = [
  // ---- the classics -------------------------------------------------------------------------
  { id: "survival", name: "Survival", category: "classic", icon: "iron_pickaxe", gameMode: "survival",
    description: "Gather, craft, build and survive the night — then go to the Nether and the End.", goal: "Slay the Ender Dragon, or just live well." },
  { id: "creative", name: "Creative", category: "classic", icon: "grass_block", gameMode: "creative", cheats: true,
    description: "Every block, free flight, no hunger or harm.", goal: "Build anything." },
  { id: "hardcore", name: "Hardcore", category: "classic", icon: "golden_apple", gameMode: "survival", hardcore: true, difficulty: 3,
    description: "Survival on the hardest difficulty, with one life.", goal: "Don't die. Ever." },
  { id: "peaceful", name: "Peaceful Builder", category: "classic", icon: "red_tulip", gameMode: "survival", difficulty: 0,
    description: "Survival without monsters: gather and build at your own pace.", goal: "Build a home worth living in." },
  { id: "superflat", name: "Superflat Creative", category: "classic", icon: "dirt", gameMode: "creative", type: "flat", cheats: true,
    description: "A flat world to the horizon, with every block in hand.", goal: "Build big." },
  { id: "void_builder", name: "Void Builder", category: "classic", icon: "glass", gameMode: "creative", map: "void", cheats: true,
    rules: { doMobSpawning: false, doWeatherCycle: false },
    description: "A single platform in an empty sky.", goal: "Fill the void." },

  // ---- minigames ----------------------------------------------------------------------------
  { id: "skyblock", name: "SkyBlock", category: "minigame", icon: "oak_sapling", gameMode: "survival", map: "skyblock", inspiredBy: "SkyBlock (Hypixel, SkyBlock maps)",
    description: "A tiny island over the void, a chest and a tree. Every challenge you finish pays out something you cannot find.", goal: "Complete every island challenge.", multiplayer: true },
  { id: "oneblock", name: "OneBlock", category: "minigame", icon: "grass_block", gameMode: "survival", map: "oneblock", inspiredBy: "OneBlock",
    description: "One block. Break it and it comes back as something else — through plains, caves, snow, ocean, jungle, desert, the Nether and the End.", goal: "Break your way to the End phase.", multiplayer: true },
  { id: "survival_games", name: "Survival Games", category: "minigame", icon: "iron_sword", gameMode: "survival", map: "sg_arena", difficulty: 2, inspiredBy: "The Survival Games, Battle Royale",
    rules: { doMobSpawning: false, naturalRegeneration: true },
    description: "Twelve pads round a cornucopia of chests. Eleven tributes want what you have. The border closes in.", goal: "Be the last one standing.", multiplayer: true },
  { id: "waves", name: "Wave Defense", category: "minigame", icon: "bow", gameMode: "survival", map: "colosseum", difficulty: 2, inspiredBy: "Mob Arena",
    rules: { doMobSpawning: false, doDaylightCycle: false, doWeatherCycle: false },
    description: "Hold the colosseum against wave after wave, each worse than the last. Gear comes between rounds.", goal: "Survive as many waves as you can.", multiplayer: true },
  { id: "parkour", name: "Parkour", category: "minigame", icon: "gold_block", gameMode: "adventure", map: "parkour", difficulty: 0, inspiredBy: "Parkour maps and servers",
    rules: { doMobSpawning: false, doWeatherCycle: false, doDaylightCycle: false, doFallDamage: false },
    description: "Forty-eight jumps in the sky over four stages, with checkpoints. The clock is running.", goal: "Reach the diamond finish, faster every time.", multiplayer: true },
  { id: "tnt_run", name: "TNT Run", category: "minigame", icon: "tnt", gameMode: "adventure", map: "tnt_run", difficulty: 0, inspiredBy: "TNT Run",
    rules: { doMobSpawning: false, doWeatherCycle: false, doDaylightCycle: false, doFallDamage: false },
    description: "Three floors over the void. Every block you step on falls away a moment later. Keep moving.", goal: "Stay up the longest.", multiplayer: true },
  { id: "uhc", name: "UHC", category: "minigame", icon: "golden_apple", gameMode: "survival", difficulty: 2, inspiredBy: "Ultra Hardcore",
    rules: { naturalRegeneration: false },
    description: "No natural healing — only golden apples and potions — and a border closing in over an hour.", goal: "Slay the Ender Dragon before the border takes you.", multiplayer: true },
  { id: "speedrun", name: "Speedrun", category: "minigame", icon: "eye_of_ender", gameMode: "survival", difficulty: 2, inspiredBy: "Any% speedrunning",
    description: "A clock from the first second, with splits at every milestone on the way to the dragon.", goal: "Beat the dragon, faster than last time.", multiplayer: true },
  { id: "lucky_blocks", name: "Lucky Blocks", category: "minigame", icon: "lucky_block", gameMode: "survival", lucky: true, inspiredBy: "The Lucky Block mod",
    description: "Yellow ? blocks all over the world. Break one: diamonds, a pet, a feast — or TNT, a horde, a trap.", goal: "Push your luck.", multiplayer: true },

  // ---- challenges ---------------------------------------------------------------------------
  { id: "randomizer", name: "Random Drops", category: "challenge", icon: "chest", gameMode: "survival", inspiredBy: "Block Randomizer challenges",
    description: "Every block and every mob drops something else — the same something every time in this world. Learn the table.", goal: "Find what drops iron, and beat the game." },
  { id: "one_heart", name: "One Heart", category: "challenge", icon: "poppy", gameMode: "survival", difficulty: 2, inspiredBy: "One-heart challenges",
    description: "Survival with a single heart. Everything is lethal.", goal: "Slay the Ender Dragon on one heart." },
  { id: "lucky_skyblock", name: "Lucky SkyBlock", category: "challenge", icon: "lucky_block", gameMode: "survival", map: "skyblock", lucky: true,
    description: "SkyBlock, but your chest holds lucky blocks instead of seeds.", goal: "Build an island from luck alone." },

  // ---- primal (after ARK: Survival Evolved and Ascended) ------------------------------------
  { id: "primal_evolved", name: "Primal: Survival Evolved", category: "primal", icon: "wooden_club", gameMode: "survival", map: "primal_island", difficulty: 2,
    fauna: "primal", primal: "evolved", vitals: { thirst: true, temperature: true }, engrams: true, multiplayer: true,
    inspiredBy: "ARK: Survival Evolved (Studio Wildcard, 2017)",
    description: "Wake on the Island's beach with nothing. Dodos, raptors, trikes, a rex. Knock them out, feed them, tame them, saddle and ride them. Learn engrams as you level; mind your water and warmth; supply drops fall from the sky.",
    goal: "Tame a rex." },
  { id: "primal_ascended", name: "Primal: Survival Ascended", category: "primal", icon: "saddle", gameMode: "survival", map: "primal_island", difficulty: 2,
    fauna: "primal", primal: "ascended", vitals: { thirst: true, temperature: true }, engrams: true, multiplayer: true,
    inspiredBy: "ARK: Survival Ascended (Studio Wildcard, 2023)",
    description: "The Island, remade: taming goes faster, every creature tells you what it eats, and the great feathered Gigantoraptor walks the plains.",
    goal: "Tame a rex and a gigantoraptor." },
  { id: "primal_wilds", name: "Primal Wilds", category: "primal", icon: "raw_meat", gameMode: "survival",
    fauna: "primal", primal: "evolved", vitals: { thirst: true },
    description: "Primal's creatures on ordinary terrain, no engrams to learn: tame and ride at your own pace in a world with villages and the End.",
    goal: "Ride something with wings." },
];

export function modeDef(id: string | undefined): ModeDef | undefined {
  return id ? MODES.find((m) => m.id === id) : undefined;
}

/** A mode for the Random button: any minigame or challenge (the classics are not a surprise). */
export function randomMode(random: () => number): ModeDef {
  const pool = MODES.filter((m) => m.category === "minigame" || m.category === "challenge" || m.category === "primal" || m.category === "zombie");
  return pool[Math.floor(random() * pool.length)];
}

/**
 * A new world, set up for a mode: its map pack, world type, rules and the
 * mode itself. Game mode, difficulty and cheats are the create screen's to
 * set (it starts them at the mode's), so they are left as they came.
 */
export function applyMode(meta: WorldMeta, def: ModeDef): WorldMeta {
  meta.mode = { id: def.id, data: {} };
  if (def.map) { meta.map = def.map; meta.type = "default"; }
  else if (def.type) meta.type = def.type;
  if (def.rules) meta.rules = { ...meta.rules, ...def.rules };
  if (def.hardcore) { meta.hardcore = true; meta.difficulty = 3; meta.cheats = false; }
  return meta;
}
