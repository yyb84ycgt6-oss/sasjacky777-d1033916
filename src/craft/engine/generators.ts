/**
 * The generator for a dimension. Kept apart from the generators themselves so
 * the Nether and End modules can import the overworld's types without the
 * overworld importing them back.
 */
import { EndGenerator } from "./end";
import { NetherGenerator } from "./nether";
import { Generator, type ChunkGenerator, type GenSettings } from "./worldgen";

export function createGenerator(settings: GenSettings): ChunkGenerator {
  switch (settings.dimension ?? "overworld") {
    case "nether": return new NetherGenerator(settings.seed);
    case "end": return new EndGenerator(settings.seed);
    case "overworld": return new Generator(settings);
    default: throw new Error(`no generator for the ${settings.dimension}`);
  }
}
