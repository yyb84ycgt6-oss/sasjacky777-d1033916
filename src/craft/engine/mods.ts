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

export const MODS: readonly ModFeature[] = [
  {
    id: "dynamic_lights", name: "Dynamic Lights", inspiredBy: "LambDynamicLights", url: "https://github.com/LambdAurora/LambDynamicLights",
    description: "A torch in your hand lights the cave around you as you walk; so do burning mobs, blazes, dropped glowstone and rockets.", toggle: true,
  },
  {
    id: "minimap", name: "Minimap, World Map & Waypoints", inspiredBy: "Xaero's Minimap and World Map, JourneyMap", url: "https://www.curseforge.com/minecraft/mc-mods/xaeros-minimap",
    description: "A map in the corner, a full map of everywhere you have been (M), and waypoints you can name, see from afar and — with cheats — teleport to. Dying leaves one.", toggle: true,
  },
  {
    id: "waystones", name: "Waystones", inspiredBy: "Waystones", url: "https://www.curseforge.com/minecraft/mc-mods/waystones",
    description: "Stones you name and activate; from any one, travel to another you have found, for a little experience. Villages keep one by the well.", toggle: true,
  },
  {
    id: "recipe_viewer", name: "Recipe Viewer", inspiredBy: "Just Enough Items (JEI)", url: "https://www.curseforge.com/minecraft/mc-mods/jei",
    description: "Every item, searchable, beside your inventory: how to make it (crafting, smelting, brewing) and what it is used for.", toggle: true,
  },
  {
    id: "seasons", name: "Seasons", inspiredBy: "Serene Seasons, Fabric Seasons", url: "https://www.curseforge.com/minecraft/mc-mods/serene-seasons",
    description: "Spring, summer, autumn and winter, a week each: leaves turn, snow falls where it rained, and crops slow in autumn and stop in winter.", toggle: true,
  },
];

/** Whether a feature is on in a world: everything is, unless the world switched it off. */
export function modEnabled(disabled: readonly string[] | undefined, id: string): boolean {
  return !disabled?.includes(id);
}
