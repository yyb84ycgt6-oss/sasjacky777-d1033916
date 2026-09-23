/**
 * The three dimensions and what differs between them.
 *
 * A world is one seed and three sets of chunks. Only one dimension is loaded
 * at a time — the one the player (online, the host) is in — so a dimension is
 * a small table of rules the rest of the game reads, not a second copy of the
 * engine.
 */
export type Dimension = "overworld" | "nether" | "end";
export const DIMENSIONS: readonly Dimension[] = ["overworld", "nether", "end"];

export interface DimensionInfo {
  /** For messages: "the Nether". */
  title: string;
  /** Sun, moon, stars, clouds, weather and the day's light. */
  hasSky: boolean;
  /**
   * Light nothing can go below (0..1). The Nether has no sky light at all, and
   * without a floor its caverns would render pitch black between lava lakes.
   */
  ambient: number;
  /** Sleeping works; elsewhere a bed explodes, as in the original. */
  bedsWork: boolean;
  /** Water poured here boils away. */
  waterEvaporates: boolean;
  /** Lava flows three times as fast and twice as far. */
  lavaFast: boolean;
  /** Overworld blocks per block here, horizontally: a step in the Nether is eight outside. */
  scale: number;
}

export const DIMENSION_INFO: Record<Dimension, DimensionInfo> = {
  overworld: { title: "the Overworld", hasSky: true, ambient: 0, bedsWork: true, waterEvaporates: false, lavaFast: false, scale: 1 },
  nether: { title: "the Nether", hasSky: false, ambient: 0.38, bedsWork: false, waterEvaporates: true, lavaFast: true, scale: 8 },
  end: { title: "the End", hasSky: false, ambient: 0.3, bedsWork: false, waterEvaporates: false, lavaFast: false, scale: 1 },
};

export const isDimension = (v: unknown): v is Dimension => v === "overworld" || v === "nether" || v === "end";
