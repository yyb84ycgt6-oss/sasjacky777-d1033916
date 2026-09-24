/**
 * The features this game borrowed from the modding community, each in its
 * own words and art, with the mod that had the idea first. The Mods screen
 * lists them with a switch each (per world), and the credits after the dragon
 * thank them by name.
 *
 * `rule` is the world's GameRules-style switch that turns the feature off;
 * a feature without one is always on (it changes nothing unless used).
 */
export interface ModFeature {
  id: string;
  /** What it is called here. */
  name: string;
  /** The mod (or mods) the idea comes from. */
  inspiredBy: string;
  /** Where to read about the original. */
  url: string;
  description: string;
  /** Can be switched off per world. */
  toggle: boolean;
}

export const MODS: readonly ModFeature[] = [];

/** Whether a feature is on in a world: everything is, unless the world switched it off. */
export function modEnabled(disabled: readonly string[] | undefined, id: string): boolean {
  return !disabled?.includes(id);
}
