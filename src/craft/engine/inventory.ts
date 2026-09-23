/**
 * Inventories and the rules for moving stacks between slots.
 *
 * Slot clicking follows the original's rules exactly, because players drive
 * inventories by reflex: left click picks up or puts down a whole stack (and
 * swaps if the item differs), right click splits a stack in half or places a
 * single item, shift-click sends a stack to the other section. Getting any of
 * these subtly different is the fastest way to make the game feel wrong.
 */
import { enchantDef } from "./enchanting";
import { itemDef, maxStack, type ItemStack } from "./items";

export type Slot = ItemStack | null;

function sameEnchants(a: ItemStack, b: ItemStack): boolean {
  const ea = a.ench ?? {}, eb = b.ench ?? {};
  const ka = Object.keys(ea), kb = Object.keys(eb);
  return ka.length === kb.length && ka.every((k) => ea[k] === eb[k]);
}

/** Whether two stacks may merge: the same item, wear, enchantments, name and anvil history. */
export function sameItem(a: Slot, b: Slot): boolean {
  return !!a && !!b && a.id === b.id && (a.damage ?? 0) === (b.damage ?? 0)
    && (a.name ?? "") === (b.name ?? "") && (a.repair ?? 0) === (b.repair ?? 0) && sameEnchants(a, b);
}

export function cloneStack(s: Slot): Slot {
  return s ? { ...s } : null;
}

export class Inventory {
  /** 0-8 hotbar, 9-35 main. */
  slots: Slot[] = new Array(36).fill(null);
  /** 0 head, 1 chest, 2 legs, 3 feet. */
  armor: Slot[] = [null, null, null, null];
  offhand: Slot = null;
  selected = 0;

  get held(): Slot {
    return this.slots[this.selected];
  }

  /** Adds as much of the stack as fits. Returns how many did not fit. */
  add(stack: ItemStack): number {
    let left = stack.count;
    const cap = maxStack(stack.id);
    // Top up matching stacks first — hotbar, then main — the way pickups land.
    for (let i = 0; i < 36 && left > 0; i++) {
      const s = this.slots[i];
      if (s && sameItem(s, stack) && s.count < cap) {
        const n = Math.min(left, cap - s.count);
        s.count += n;
        left -= n;
      }
    }
    for (let i = 0; i < 36 && left > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(left, cap);
        this.slots[i] = { ...stack, count: n };
        left -= n;
      }
    }
    return left;
  }

  count(id: number): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Removes `count` of an item from anywhere. Returns false (and removes nothing) if there is not enough. */
  remove(id: number, count: number): boolean {
    if (this.count(id) < count) return false;
    let left = count;
    for (let i = 35; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const n = Math.min(left, s.count);
        s.count -= n;
        left -= n;
        if (s.count <= 0) this.slots[i] = null;
      }
    }
    return true;
  }

  consumeHeld(n = 1): void {
    const s = this.slots[this.selected];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
  }

  /** Wears the held tool; returns true if it broke. */
  damageHeld(amount = 1): boolean {
    const s = this.slots[this.selected];
    if (!s) return false;
    const max = itemDef(s.id)?.durability;
    if (!max) return false;
    s.damage = (s.damage ?? 0) + amount;
    if (s.damage >= max) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  armorPoints(): number {
    let p = 0;
    for (const a of this.armor) if (a) p += itemDef(a.id)?.armor?.points ?? 0;
    return p;
  }

  armorToughness(): number {
    let p = 0;
    for (const a of this.armor) if (a) p += itemDef(a.id)?.armor?.toughness ?? 0;
    return p;
  }

  clear(): void {
    this.slots.fill(null);
    this.armor = [null, null, null, null];
    this.offhand = null;
  }

  isEmpty(): boolean {
    return this.slots.every((s) => !s) && this.armor.every((s) => !s) && !this.offhand;
  }

  toJSON(): { slots: Slot[]; armor: Slot[]; offhand: Slot; selected: number } {
    return { slots: this.slots, armor: this.armor, offhand: this.offhand, selected: this.selected };
  }

  load(data: { slots?: Slot[]; armor?: Slot[]; offhand?: Slot; selected?: number } | undefined): void {
    if (!data) return;
    this.slots = sanitize(data.slots, 36);
    this.armor = sanitize(data.armor, 4);
    this.offhand = sanitize([data.offhand ?? null], 1)[0];
    this.selected = Math.max(0, Math.min(8, data.selected ?? 0));
  }
}

/** Drops anything malformed or unknown from saved or received slot lists — a bad save should cost a slot, not the game. */
export function sanitize(list: unknown, size: number): Slot[] {
  const out: Slot[] = new Array(size).fill(null);
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < size; i++) {
    const s = list[i] as ItemStack | null;
    out[i] = sanitizeStack(list[i]);
    if (out[i]) out[i] = { ...out[i]!, count: Math.min(out[i]!.count, maxStack(out[i]!.id)) };
  }
  return out;
}

/**
 * One stack from a save or another player, keeping only what is well formed:
 * known enchantments at sane levels, a short name, a small anvil penalty.
 */
export function sanitizeStack(value: unknown): Slot {
  const s = value as ItemStack | null;
  if (!s || typeof s !== "object" || typeof s.id !== "number" || typeof s.count !== "number" || s.count <= 0 || !itemDef(s.id)) return null;
  const out: ItemStack = { id: s.id, count: Math.floor(s.count) };
  if (typeof s.damage === "number" && s.damage > 0) out.damage = Math.floor(s.damage);
  if (s.ench && typeof s.ench === "object") {
    const ench: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.ench)) {
      if (enchantDef(k) && typeof v === "number" && v >= 1 && v <= 10) ench[k] = Math.floor(v);
    }
    if (Object.keys(ench).length) out.ench = ench;
  }
  if (typeof s.name === "string" && s.name.trim()) out.name = s.name.slice(0, 35);
  if (typeof s.repair === "number" && s.repair > 0) out.repair = Math.min(63, Math.floor(s.repair));
  return out;
}

export type ClickButton = "left" | "right";

/**
 * One click on a slot with `cursor` held. Returns the new [slot, cursor].
 * `accepts` limits what may be put in (armour slots, furnace fuel, outputs).
 */
export function clickSlot(slot: Slot, cursor: Slot, button: ClickButton, accepts: (s: ItemStack) => boolean = () => true, slotCap = 64): [Slot, Slot] {
  slot = cloneStack(slot);
  cursor = cloneStack(cursor);
  if (!cursor) {
    if (!slot) return [null, null];
    if (button === "left") return [null, slot];
    const take = Math.ceil(slot.count / 2);
    const rest = slot.count - take;
    return [rest > 0 ? { ...slot, count: rest } : null, { ...slot, count: take }];
  }
  if (!accepts(cursor)) return [slot, cursor];
  const cap = Math.min(slotCap, maxStack(cursor.id));
  if (!slot) {
    if (button === "left") {
      const n = Math.min(cap, cursor.count);
      const rest = cursor.count - n;
      return [{ ...cursor, count: n }, rest > 0 ? { ...cursor, count: rest } : null];
    }
    const rest = cursor.count - 1;
    return [{ ...cursor, count: 1 }, rest > 0 ? { ...cursor, count: rest } : null];
  }
  if (sameItem(slot, cursor)) {
    const room = cap - slot.count;
    if (room <= 0) return [slot, cursor];
    const n = button === "left" ? Math.min(room, cursor.count) : 1;
    slot.count += n;
    const rest = cursor.count - n;
    return [slot, rest > 0 ? { ...cursor, count: rest } : null];
  }
  // Different items: swap (only when the whole cursor stack fits).
  if (cursor.count <= cap) return [cursor, slot];
  return [slot, cursor];
}

/** Moves a stack into a list of slots, merging first. Returns what is left over. */
export function mergeInto(stack: ItemStack, slots: Slot[], indices: number[]): Slot {
  let left = stack.count;
  const cap = maxStack(stack.id);
  for (const i of indices) {
    const s = slots[i];
    if (left > 0 && s && sameItem(s, stack) && s.count < cap) {
      const n = Math.min(left, cap - s.count);
      s.count += n;
      left -= n;
    }
  }
  for (const i of indices) {
    if (left > 0 && !slots[i]) {
      const n = Math.min(left, cap);
      slots[i] = { ...stack, count: n };
      left -= n;
    }
  }
  return left > 0 ? { ...stack, count: left } : null;
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}
