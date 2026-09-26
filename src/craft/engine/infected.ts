/**
 * The infected (Dead Zone and the zombie modes): which mobs count as one.
 * A bite from any of them can open a wound and, now and then, bring on a
 * fever (engine/vitals.ts). The overworld's own zombie counts for bites, but
 * keeps its own shamble; the rest behave as infectedAi.ts says.
 */
export const INFECTED_KINDS = ["infected", "runner", "brute", "spitter", "screamer", "bloater"] as const;
export type InfectedKind = (typeof INFECTED_KINDS)[number];

/** One of Dead Zone's infected (not the overworld's zombie). */
export const isInfectedMob = (kind: string): kind is InfectedKind => (INFECTED_KINDS as readonly string[]).includes(kind);

/** Anything whose bite can infect: the infected, and the plain zombie. */
export const isInfected = (kind: string): boolean => kind === "zombie" || isInfectedMob(kind);

/** Which infected a spawn brings, by weight: mostly walkers, a few of each worse kind. */
export const INFECTED_SPAWNS: readonly [InfectedKind, number][] = [
  ["infected", 50], ["runner", 18], ["bloater", 10], ["spitter", 8], ["screamer", 6], ["brute", 5],
];

export function pickInfected(random: () => number): InfectedKind {
  const total = INFECTED_SPAWNS.reduce((t, [, w]) => t + w, 0);
  let r = random() * total;
  for (const [k, w] of INFECTED_SPAWNS) { r -= w; if (r < 0) return k; }
  return "infected";
}
