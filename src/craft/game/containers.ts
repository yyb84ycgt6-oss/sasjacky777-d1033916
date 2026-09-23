/**
 * Clicking in inventory screens: the player's inventory, armour, the crafting
 * grids, chests, furnaces and the creative palette.
 *
 * Shift-click routing follows the original per screen — from the hotbar to the
 * main inventory and back, into the open chest, smeltables into the furnace's
 * input and fuel into its fuel slot — because that is the move experienced
 * players make hundreds of times a session without looking.
 */
import { clickSlot, mergeInto, range, sameItem, type ClickButton, type Slot } from "../engine/inventory";
import { consumeGrid, fuelTicks, layout, matchRecipe, recipeResult, smeltResult, type Recipe } from "../engine/crafting";
import { itemDef, maxStack, type ItemStack } from "../engine/items";
import type { ChestEntity, FurnaceEntity } from "../engine/chunk";
import type { Game } from "./game";

export type Section = "inv" | "armor" | "offhand" | "grid" | "result" | "chest" | "furnace";

function chestOf(game: Game): ChestEntity | null {
  const s = game.screen;
  if (s?.kind !== "chest") return null;
  const e = game.world.getEntity(s.x, s.y, s.z);
  return e?.kind === "chest" ? e : null;
}

function furnaceOf(game: Game): FurnaceEntity | null {
  const s = game.screen;
  if (s?.kind !== "furnace") return null;
  const e = game.world.getEntity(s.x, s.y, s.z);
  return e?.kind === "furnace" ? e : null;
}

export function craftWidth(game: Game): number {
  return game.screen?.kind === "crafting" ? 3 : 2;
}

export function craftOutput(game: Game): { recipe: Recipe; stack: ItemStack } | null {
  if (game.screen?.kind !== "inventory" && game.screen?.kind !== "crafting") return null;
  const r = matchRecipe(game.craftGrid, craftWidth(game));
  return r ? { recipe: r, stack: recipeResult(r) } : null;
}

function changed(game: Game): void {
  const s = game.screen;
  if (s && (s.kind === "chest" || s.kind === "furnace")) game.containerChanged(s.x, s.y, s.z);
  else game.bumpInv();
}

function accepts(section: Section, index: number): (s: ItemStack) => boolean {
  if (section === "armor") return (s) => itemDef(s.id)?.armor?.slot === index;
  if (section === "furnace" && index === 1) return (s) => fuelTicks(s.id) > 0;
  if (section === "furnace" && index === 2) return () => false;
  return () => true;
}

function sectionSlots(game: Game, section: Section): Slot[] | null {
  const inv = game.player.inventory;
  switch (section) {
    case "inv": return inv.slots;
    case "armor": return inv.armor;
    case "grid": return game.craftGrid;
    case "chest": return chestOf(game)?.items ?? null;
    default: return null;
  }
}

function getFurnaceSlot(f: FurnaceEntity, i: number): Slot {
  return i === 0 ? f.input : i === 1 ? f.fuel : f.output;
}
function setFurnaceSlot(f: FurnaceEntity, i: number, s: Slot): void {
  if (i === 0) f.input = s; else if (i === 1) f.fuel = s; else f.output = s;
}

/** Moves a stack to where shift-click sends it on the current screen; returns what did not fit. */
function quickMove(game: Game, from: Section, index: number, stack: ItemStack): Slot {
  const inv = game.player.inventory;
  const kind = game.screen?.kind;
  if (from === "inv") {
    if (kind === "chest") {
      const chest = chestOf(game);
      if (chest) return mergeInto(stack, chest.items, range(0, chest.items.length));
    }
    if (kind === "furnace") {
      const f = furnaceOf(game);
      if (f) {
        const target = smeltResult(stack.id) ? 0 : fuelTicks(stack.id) > 0 ? 1 : -1;
        if (target >= 0) {
          const cur = getFurnaceSlot(f, target);
          const slots: Slot[] = [cur];
          const left = mergeInto(stack, slots, [0]);
          setFurnaceSlot(f, target, slots[0]);
          return left;
        }
      }
    }
    if (kind === "inventory") {
      const armor = itemDef(stack.id)?.armor;
      if (armor && !inv.armor[armor.slot]) { inv.armor[armor.slot] = stack; return null; }
    }
    return mergeInto(stack, inv.slots, index < 9 ? range(9, 36) : range(0, 9));
  }
  // Everything else goes back into the player's inventory, hotbar last like the original.
  return mergeInto(stack, inv.slots, [...range(9, 36), ...range(0, 9)]);
}

export function clickContainer(game: Game, section: Section, index: number, button: ClickButton, shift: boolean): void {
  const inv = game.player.inventory;
  if (section === "result") { takeResult(game, shift); return; }

  if (section === "furnace") {
    const f = furnaceOf(game);
    if (!f) return;
    const cur = getFurnaceSlot(f, index);
    if (shift && cur) {
      setFurnaceSlot(f, index, quickMove(game, "furnace", index, cur));
    } else if (index === 2) {
      // Output: take only, and collect the experience banked by smelting.
      if (!cur) return;
      if (game.cursor && !(sameItem(game.cursor, cur) && game.cursor.count + cur.count <= maxStack(cur.id))) return;
      game.cursor = game.cursor ? { ...game.cursor, count: game.cursor.count + cur.count } : cur;
      setFurnaceSlot(f, 2, null);
    } else {
      const [slot, cursor] = clickSlot(cur, game.cursor, button, accepts("furnace", index));
      setFurnaceSlot(f, index, slot);
      game.cursor = cursor;
    }
    if (index === 2 && f.xp >= 1) {
      const whole = Math.floor(f.xp);
      game.addXp(whole);
      f.xp -= whole;
    }
    changed(game);
    return;
  }

  if (section === "offhand") {
    const [slot, cursor] = clickSlot(inv.offhand, game.cursor, button);
    inv.offhand = slot;
    game.cursor = cursor;
    changed(game);
    return;
  }

  const slots = sectionSlots(game, section);
  if (!slots) return;
  if (shift) {
    const cur = slots[index];
    if (!cur) return;
    slots[index] = quickMove(game, section, index, cur);
  } else {
    const cap = section === "armor" ? 1 : 64;
    const [slot, cursor] = clickSlot(slots[index], game.cursor, button, accepts(section, index), cap);
    slots[index] = slot;
    game.cursor = cursor;
  }
  changed(game);
}

function takeResult(game: Game, shift: boolean): void {
  const out = craftOutput(game);
  if (!out) return;
  const width = craftWidth(game);
  const inv = game.player.inventory;
  if (shift) {
    // Craft as many as fit, re-matching each time (the grid changes as it empties).
    for (let i = 0; i < 64; i++) {
      const r = matchRecipe(game.craftGrid, width);
      if (!r || r.id !== out.recipe.id) break;
      const stack = recipeResult(r);
      const probe = inv.slots.map((s) => (s ? { ...s } : null));
      if (mergeInto(stack, probe, range(0, 36))) break;
      mergeInto(stack, inv.slots, [...range(9, 36), ...range(0, 9)]);
      game.craftGrid = consumeGrid(game.craftGrid);
    }
  } else {
    const stack = out.stack;
    if (game.cursor) {
      if (!sameItem(game.cursor, stack) || game.cursor.count + stack.count > maxStack(stack.id)) return;
      game.cursor = { ...game.cursor, count: game.cursor.count + stack.count };
    } else game.cursor = { ...stack };
    game.craftGrid = consumeGrid(game.craftGrid);
  }
  game.sound("click", null, 0, 0, 0.2, 1.4);
  game.bumpInv();
}

/** Clicking outside any slot drops the held stack (or one item with right click). */
export function dropCursor(game: Game, one: boolean): void {
  if (!game.cursor) return;
  const n = one ? 1 : game.cursor.count;
  game.actions.throwStack({ ...game.cursor, count: n });
  game.cursor = game.cursor.count > n ? { ...game.cursor, count: game.cursor.count - n } : null;
  game.bumpInv();
}

/** Creative palette: pick up a full stack (shift/middle: into the hotbar). */
export function creativeTake(game: Game, itemId: number, button: ClickButton, shift: boolean): void {
  const def = itemDef(itemId);
  if (!def) return;
  const count = button === "right" ? 1 : def.maxStack;
  if (shift) {
    game.player.inventory.add({ id: itemId, count: def.maxStack });
  } else if (game.cursor && game.cursor.id === itemId && button === "left") {
    game.cursor = { ...game.cursor, count: Math.min(def.maxStack, game.cursor.count + 1) };
  } else {
    game.cursor = { id: itemId, count };
  }
  game.bumpInv();
}

export function creativeTrash(game: Game): void {
  game.cursor = null;
  game.bumpInv();
}

/** Recipe book: moves the ingredients for one craft (or as many as possible) from the inventory into the grid. */
export function fillRecipe(game: Game, recipe: Recipe, all: boolean): boolean {
  const width = craftWidth(game);
  const inv = game.player.inventory;
  // Start from an empty grid, returning whatever was there.
  for (let i = 0; i < game.craftGrid.length; i++) {
    const s = game.craftGrid[i];
    if (s) {
      const left = inv.add(s);
      if (left > 0) game.actions.throwStack({ ...s, count: left });
      game.craftGrid[i] = null;
    }
  }
  const take = (ids: number[]): number | null => {
    for (let i = 35; i >= 0; i--) {
      const s = inv.slots[i];
      if (s && ids.includes(s.id)) {
        const id = s.id;
        s.count--;
        if (s.count <= 0) inv.slots[i] = null;
        return id;
      }
    }
    return null;
  };
  const snapshot = inv.slots.map((s) => (s ? { ...s } : null));
  const first = layout(recipe, width, take);
  if (!first) {
    inv.slots = snapshot;
    game.bumpInv();
    return false;
  }
  game.craftGrid = first;
  if (all) {
    for (let n = 1; n < 64; n++) {
      const before = inv.slots.map((s) => (s ? { ...s } : null));
      const more = layout(recipe, width, take);
      if (!more || more.some((s, i) => (s ? !first[i] || s.id !== first[i]!.id : false))) { inv.slots = before; break; }
      let full = false;
      game.craftGrid = game.craftGrid.map((s, i) => {
        if (!s) return s;
        if (s.count >= maxStack(s.id)) full = true;
        return { ...s, count: s.count + (more[i] ? 1 : 0) };
      });
      if (full) break;
    }
  }
  game.bumpInv();
  return true;
}

/** Item counts in the inventory by id, for the recipe book's "can craft" check. */
export function inventoryCounts(game: Game): Map<number, number> {
  const counts = new Map<number, number>();
  for (const s of [...game.player.inventory.slots, ...game.craftGrid]) if (s) counts.set(s.id, (counts.get(s.id) ?? 0) + s.count);
  return counts;
}

export function furnaceView(game: Game): FurnaceEntity | null {
  return furnaceOf(game);
}

export function chestView(game: Game): ChestEntity | null {
  return chestOf(game);
}
