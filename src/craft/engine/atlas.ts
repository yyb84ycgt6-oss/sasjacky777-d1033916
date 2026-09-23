/**
 * All textures in one list, in a fixed order, ready to upload as a texture
 * array. A texture array rather than a 2D atlas because every layer gets its
 * own mip chain: a 2D atlas bleeds neighbouring tiles into each other at a
 * distance, which is the purple fringe on grass you see in cheap voxel demos.
 *
 * Water and lava come first and take ANIM_FRAMES consecutive layers each;
 * the shader animates them by adding the frame number to the layer.
 */
import { ANIM_FRAMES, blockTextureNames, itemTextureNames, missingTexture, paintTexture, TEX } from "./textures";

export interface AtlasData {
  names: string[];
  layers: Record<string, number>;
  /** RGBA, TEX*TEX*4 bytes per layer. */
  pixels: Uint8Array;
  count: number;
}

let cached: AtlasData | null = null;

export function buildAtlas(): AtlasData {
  if (cached) return cached;
  const names: string[] = [];
  const frames: Uint8ClampedArray[] = [];
  const layers: Record<string, number> = {};
  const add = (name: string, data: Uint8ClampedArray) => {
    if (layers[name] === undefined) layers[name] = frames.length;
    names.push(name);
    frames.push(data);
  };
  for (const fluid of ["water_still", "lava_still"]) {
    for (let f = 0; f < ANIM_FRAMES; f++) add(fluid, paintTexture(fluid, f)!.data);
  }
  add("__missing__", missingTexture().data);
  for (let s = 0; s < 10; s++) add(`destroy_stage_${s}`, paintTexture(`destroy_stage_${s}`)!.data);
  for (const name of [...blockTextureNames(), ...itemTextureNames()]) {
    if (layers[name] !== undefined) continue;
    const p = paintTexture(name);
    if (p) add(name, p.data);
  }
  const pixels = new Uint8Array(frames.length * TEX * TEX * 4);
  frames.forEach((f, i) => pixels.set(f, i * TEX * TEX * 4));
  cached = { names, layers, pixels, count: frames.length };
  return cached;
}

/** Layer for a texture name, falling back to the loud missing-texture layer. */
export function layerOf(name: string): number {
  const a = buildAtlas();
  return a.layers[name] ?? a.layers["__missing__"];
}

/** A copy of one layer's pixels (for icons). */
export function layerPixels(name: string): Uint8ClampedArray {
  const a = buildAtlas();
  const l = layerOf(name);
  return new Uint8ClampedArray(a.pixels.buffer, l * TEX * TEX * 4, TEX * TEX * 4).slice();
}
