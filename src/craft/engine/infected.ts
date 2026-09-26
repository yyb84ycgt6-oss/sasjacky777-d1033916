/**
 * The infected (Dead Zone and the zombie modes): which mobs count as one.
 * A bite from any of them can open a wound and, now and then, bring on a
 * fever (engine/vitals.ts).
 */
export const INFECTED_KINDS = ["zombie", "infected", "runner", "brute", "spitter", "screamer", "bloater", "crawler"] as const;

export const isInfected = (kind: string): boolean => (INFECTED_KINDS as readonly string[]).includes(kind);
