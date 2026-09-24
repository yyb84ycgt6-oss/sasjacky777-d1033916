import type { Slot } from "../engine/inventory";
import type { GameMode } from "../engine/player";
import type { LinkKind } from "../net/transport";

/** What the input layer (keyboard/mouse or touch) writes and the game reads each frame. */
export interface Controls {
  forward: number;
  strafe: number;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
  attack: boolean;
  use: boolean;
  /** Radians of look movement since the game last read them. */
  lookX: number;
  lookY: number;
  /** For tap-to-interact: where on screen (-1..1) the finger is, or null for the crosshair. */
  aim: { x: number; y: number } | null;
  actions: GameAction[];
}

export type GameAction =
  | { type: "hotbar"; slot: number }
  | { type: "scroll"; delta: number }
  | { type: "drop"; all: boolean }
  | { type: "inventory" }
  | { type: "chat"; text?: string }
  | { type: "pause" }
  | { type: "pickBlock" }
  | { type: "perspective" }
  | { type: "debug" }
  | { type: "hideHud" }
  | { type: "screenshot" }
  | { type: "toggleFly" }
  | { type: "close" };

export function emptyControls(): Controls {
  return { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false, attack: false, use: false, lookX: 0, lookY: 0, aim: null, actions: [] };
}

export type Screen =
  | { kind: "pause" }
  | { kind: "inventory" }
  | { kind: "crafting"; x: number; y: number; z: number }
  | { kind: "furnace"; x: number; y: number; z: number }
  | { kind: "chest"; x: number; y: number; z: number }
  | { kind: "brewing"; x: number; y: number; z: number }
  | { kind: "enchanting"; x: number; y: number; z: number }
  | { kind: "anvil"; x: number; y: number; z: number }
  | { kind: "smithing"; x: number; y: number; z: number }
  | { kind: "trade"; entityId: number }
  | { kind: "chat"; text: string }
  | { kind: "options" }
  | { kind: "share" }
  | { kind: "death" }
  | { kind: "advancements" };

export interface ChatLine {
  id: number;
  text: string;
  color?: string;
  at: number;
}

export interface Hud {
  health: number;
  food: number;
  air: number;
  armor: number;
  xpLevel: number;
  xpProgress: number;
  absorption: number;
  hotbar: Slot[];
  selected: number;
  heldName: string;
  heldNameAt: number;
  gameMode: GameMode;
  hardcore: boolean;
  screen: Screen | null;
  chat: ChatLine[];
  dead: boolean;
  deathMessage: string;
  loading: { done: number; total: number; message: string } | null;
  attackCharge: number;
  breaking: number;
  hurtAt: number;
  sleeping: number;
  hudHidden: boolean;
  debug: string[] | null;
  coords: string | null;
  fps: number;
  /** Bumped whenever an inventory or container changes, so open screens re-render. */
  inv: number;
  title: { text: string; sub?: string; at: number } | null;
  actionbar: { text: string; at: number } | null;
  net: { role: "host" | "guest"; room: string; kind: LinkKind; players: string[]; status: string; addresses?: string[] } | null;
  saveProblem: string | null;
  saving: boolean;
  onFire: boolean;
  underwater: boolean;
  /** How far through a portal's four seconds the player is (0 when not in one): the screen swirls purple. */
  portal: number;
  perspective: 0 | 1 | 2;
  /** Active status effects, for the list in the corner. */
  effects: { kind: string; amp: number; seconds: number }[];
  /** Advancements earned in the last few seconds, newest last. */
  toasts: { id: string; title: string; icon: string; at: number }[];
  /** A boss in range (the dragon): its name and health, 0..1. */
  boss: { name: string; health: number } | null;
}
