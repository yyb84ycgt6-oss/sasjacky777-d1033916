/**
 * Procedural textures: every block face and item sprite is painted here, in
 * code, at 16×16.
 *
 * Nothing is loaded from a file or a server. That is deliberate on three
 * counts: the original game's textures are not ours to ship; a texture pack
 * fetched at runtime is a game that shows magenta checkerboards the first time
 * someone opens it on a train; and the whole art set costs a few kilobytes of
 * source instead of megabytes of PNG in the bundle.
 *
 * Painters write straight into RGBA byte arrays — no canvas — so they run the
 * same in the worker, in tests and on the main thread. Each texture's random
 * stream is seeded from its own name, so the art is identical on every device
 * and every launch, which matters when two players compare what they see.
 *
 * Tinted textures (grass, leaves, water) are painted in greys and coloured per
 * biome at mesh time. On an opaque texture, alpha below 255 marks pixels that
 * take the tint — that is how the grass side's green fringe follows the biome
 * while the dirt beneath it stays brown.
 */
import { Rng, seedFromString } from "./rng";
import { Simplex } from "./noise";

export const TEX = 16;
export const ANIM_FRAMES = 16;

type C = readonly [number, number, number];

export function hex(h: string): C {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const shade = (c: C, f: number): C => [clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f)];
const mix = (a: C, b: C, t: number): C => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const grey = (v: number): C => [v, v, v];
function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export class Pixels {
  readonly data = new Uint8ClampedArray(TEX * TEX * 4);
  set(x: number, y: number, c: C, a = 255): void {
    if (x < 0 || y < 0 || x >= TEX || y >= TEX) return;
    const i = (y * TEX + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }
  get(x: number, y: number): C {
    const i = (((y + TEX) % TEX) * TEX + ((x + TEX) % TEX)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2]];
  }
  alpha(x: number, y: number): number {
    return this.data[(y * TEX + x) * 4 + 3];
  }
  fill(c: C, a = 255): void {
    for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) this.set(x, y, c, a);
  }
  clear(): void {
    this.data.fill(0);
  }
  copyFrom(other: Pixels): void {
    this.data.set(other.data);
  }
}

/** Tileable value noise on a g×g grid, sampled at 16×16. Wraps so faces tile without seams. */
function valueNoise(rng: Rng, g: number, gy = g): number[] {
  const grid: number[] = [];
  for (let i = 0; i < g * gy; i++) grid.push(rng.next());
  const out: number[] = new Array(TEX * TEX);
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const fx = (x / TEX) * g, fy = (y / TEX) * gy;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = sm(fx - x0), ty = sm(fy - y0);
      const x1 = (x0 + 1) % g, y1 = (y0 + 1) % gy;
      const a = grid[y0 * g + x0], b = grid[y0 * g + x1], c = grid[y1 * g + x0], d = grid[y1 * g + x1];
      out[y * TEX + x] = a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
    }
  }
  return out;
}

function noisy(p: Pixels, rng: Rng, base: C, amount: number, cell = 4): void {
  const n = valueNoise(rng, cell);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const f = 1 + (n[y * TEX + x] - 0.5) * amount + (rng.next() - 0.5) * amount * 0.6;
      p.set(x, y, shade(base, f));
    }
  }
}

function palette(p: Pixels, rng: Rng, colors: C[], cell = 4, jitter = 0.35): void {
  const n = valueNoise(rng, cell);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      let v = n[y * TEX + x] + (rng.next() - 0.5) * jitter;
      v = Math.max(0, Math.min(0.999, v));
      p.set(x, y, colors[Math.floor(v * colors.length)]);
    }
  }
}

function speckle(p: Pixels, rng: Rng, colors: C[], density: number): void {
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) if (rng.next() < density) p.set(x, y, rng.pick(colors));
}

function bevel(p: Pixels, light = 1.15, dark = 0.8): void {
  for (let i = 0; i < TEX; i++) {
    p.set(i, 0, shade(p.get(i, 0), light));
    p.set(0, i, shade(p.get(0, i), light));
    p.set(i, 15, shade(p.get(i, 15), dark));
    p.set(15, i, shade(p.get(15, i), dark));
  }
}

// ---- stone family ---------------------------------------------------------------

function stone(p: Pixels, rng: Rng, base = hex("#7f7f7f")): void {
  noisy(p, rng, base, 0.22, 4);
  speckle(p, rng, [shade(base, 0.82), shade(base, 0.88)], 0.12);
  speckle(p, rng, [shade(base, 1.12)], 0.06);
}

function cobble(p: Pixels, rng: Rng, stones: C[], mortar: C): void {
  const pts: [number, number, C][] = [];
  const count = 11;
  for (let i = 0; i < count; i++) pts.push([rng.next() * 16, rng.next() * 16, rng.pick(stones)]);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      let d1 = 1e9, d2 = 1e9, c: C = stones[0];
      for (const [px, py, pc] of pts) {
        for (let oy = -16; oy <= 16; oy += 16) {
          for (let ox = -16; ox <= 16; ox += 16) {
            const dx = x - px - ox, dy = y - py - oy;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < d1) { d2 = d1; d1 = d; c = pc; } else if (d < d2) d2 = d;
          }
        }
      }
      if (d2 - d1 < 1.1) p.set(x, y, shade(mortar, 0.9 + rng.next() * 0.2));
      else p.set(x, y, shade(c, 0.92 + rng.next() * 0.16 + (d2 - d1 > 3.5 ? 0.06 : 0)));
    }
  }
}

function ore(p: Pixels, rng: Rng, base: (p: Pixels, r: Rng) => void, colors: C[], clusters = 5): void {
  base(p, rng);
  for (let i = 0; i < clusters; i++) {
    const cx = 1 + rng.int(13), cy = 1 + rng.int(13);
    const size = 2 + rng.int(3);
    for (let j = 0; j < size + 1; j++) {
      const x = cx + rng.int(3) - 1, y = cy + rng.int(3) - 1;
      p.set(x + 1, y + 1, shade(p.get(x + 1, y + 1), 0.7));
      p.set(x, y, colors[j === 0 ? colors.length - 1 : rng.int(colors.length)]);
    }
  }
}

function deepslate(p: Pixels, rng: Rng): void {
  const base = hex("#505055");
  const n = valueNoise(rng, 8, 2);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const f = 0.85 + n[y * TEX + x] * 0.25 + (rng.next() - 0.5) * 0.12 - (y % 4 === 0 ? 0.06 : 0);
      p.set(x, y, shade(base, f));
    }
  }
}

function bricksPattern(p: Pixels, rng: Rng, brick: C, mortar: C, rowH: number, brickW: number): void {
  for (let y = 0; y < TEX; y++) {
    const row = Math.floor(y / rowH);
    const offset = row % 2 === 0 ? 0 : brickW / 2;
    for (let x = 0; x < TEX; x++) {
      const inRowY = y % rowH;
      const inBrickX = (x + offset) % brickW;
      if (inRowY === rowH - 1 || inBrickX === brickW - 1) p.set(x, y, shade(mortar, 0.92 + rng.next() * 0.12));
      else {
        let f = 0.9 + rng.next() * 0.18;
        if (inRowY === 0) f += 0.08;
        if (inRowY === rowH - 2) f -= 0.08;
        p.set(x, y, shade(brick, f));
      }
    }
  }
}

function polished(p: Pixels, rng: Rng, base: C): void {
  noisy(p, rng, base, 0.08, 2);
  bevel(p, 1.12, 0.78);
}

function moss(p: Pixels, rng: Rng, coverage: number): void {
  const n = valueNoise(rng, 4);
  const greens = [hex("#5a7a2e"), hex("#4a6b25"), hex("#6d8c3a")];
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) if (n[y * TEX + x] < coverage) p.set(x, y, rng.pick(greens));
}

// ---- wood --------------------------------------------------------------------------

function planks(p: Pixels, rng: Rng, base: C): void {
  const n = valueNoise(rng, 2, 8);
  for (let y = 0; y < TEX; y++) {
    const board = y >> 2;
    const joint = (board * 7 + 3) % 16;
    for (let x = 0; x < TEX; x++) {
      let f = 0.9 + n[y * TEX + x] * 0.16 + (rng.next() - 0.5) * 0.06;
      if (y % 4 === 3) f = 0.62;
      else if (x === joint) f = 0.7;
      else if (y % 4 === 0) f += 0.05;
      p.set(x, y, shade(base, f));
    }
  }
}

function bark(p: Pixels, rng: Rng, base: C, dark: C): void {
  const n = valueNoise(rng, 8, 2);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const v = n[y * TEX + x] + (rng.next() - 0.5) * 0.3;
      p.set(x, y, v < 0.35 ? dark : shade(base, 0.9 + v * 0.2));
    }
  }
}

function birchBark(p: Pixels, rng: Rng): void {
  noisy(p, rng, hex("#d9d7cf"), 0.1, 4);
  for (let i = 0; i < 9; i++) {
    const y = rng.int(16), x = rng.int(16), len = 2 + rng.int(4);
    for (let j = 0; j < len; j++) p.set((x + j) % 16, y, j === 0 ? hex("#555") : hex("#2d2d2d"));
  }
}

function logTop(p: Pixels, rng: Rng, inner: C, barkColor: C): void {
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.5) p.set(x, y, shade(barkColor, 0.9 + rng.next() * 0.2));
      else {
        const ring = Math.floor(d) % 2;
        p.set(x, y, shade(inner, (ring ? 0.86 : 1) + (rng.next() - 0.5) * 0.06));
      }
    }
  }
}

function leaves(p: Pixels, rng: Rng, holes = 0.22): void {
  const n = valueNoise(rng, 4);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const v = n[y * TEX + x] + (rng.next() - 0.5) * 0.5;
      if (rng.next() < holes && v < 0.55) p.set(x, y, grey(40), 0);
      else p.set(x, y, grey(90 + Math.max(0, Math.min(1, v)) * 90));
    }
  }
}

// ---- plants ----------------------------------------------------------------------------

/** Paints an ASCII template; unknown characters are transparent. */
function template(p: Pixels, rows: readonly string[], colors: Record<string, C>, dy = 0): void {
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      const c = colors[row[x]];
      if (c) p.set(x, y + dy, c);
    }
  }
}

function stem(p: Pixels, x: number, from: number, to: number, c: C): void {
  for (let y = from; y <= to; y++) p.set(x, y, c);
}

function flower(p: Pixels, rng: Rng, petal: C, center: C, kind: "round" | "tall" | "tulip" | "ball" | "bells"): void {
  p.clear();
  const green = hex("#3f7f28"), dark = hex("#2d5e1c");
  stem(p, 7, 7, 15, green);
  p.set(6, 12, green); p.set(5, 11, dark); p.set(8, 11, green); p.set(9, 10, dark);
  if (kind === "round") {
    for (const [x, y] of [[6, 4], [7, 4], [8, 4], [5, 5], [9, 5], [5, 6], [9, 6], [6, 7], [8, 7], [6, 5], [8, 5], [6, 6], [8, 6], [7, 7]]) p.set(x, y, petal);
    p.set(7, 5, center); p.set(7, 6, center);
  } else if (kind === "tall") {
    for (let y = 2; y < 8; y++) { p.set(6, y, shade(petal, 0.85)); p.set(7, y, petal); p.set(8, y, shade(petal, 0.9)); }
    p.set(7, 1, petal); p.set(5, 4, petal); p.set(9, 5, petal);
  } else if (kind === "tulip") {
    for (let y = 3; y < 8; y++) for (let x = 6; x <= 8; x++) p.set(x, y, shade(petal, y === 3 ? 1.15 : 0.95 + (x - 6) * 0.05));
    p.set(5, 4, petal); p.set(9, 4, petal); p.set(7, 2, shade(petal, 1.2));
  } else if (kind === "ball") {
    for (let y = 2; y < 8; y++) for (let x = 5; x <= 9; x++) {
      const d = Math.hypot(x - 7, y - 4.5);
      if (d < 2.8) p.set(x, y, shade(petal, 0.85 + rng.next() * 0.3));
    }
  } else {
    for (const [x, y] of [[5, 5], [9, 3], [6, 8], [9, 7]]) { p.set(x, y, petal); p.set(x, y + 1, shade(petal, 0.85)); }
    p.set(8, 4, green); p.set(6, 6, green);
  }
}

function sapling(p: Pixels, rng: Rng, leaf: C, trunk: C): void {
  p.clear();
  stem(p, 7, 9, 15, trunk);
  stem(p, 8, 11, 15, shade(trunk, 0.8));
  for (let y = 1; y < 11; y++) {
    for (let x = 2; x < 14; x++) {
      const d = Math.hypot((x - 7.5) * 1.1, y - 5.5);
      if (d < 5 && rng.next() < 0.78) p.set(x, y, shade(leaf, 0.75 + rng.next() * 0.45));
    }
  }
}

function blades(p: Pixels, rng: Rng, count: number, maxH: number, color: C | null, spread = 1): void {
  p.clear();
  for (let i = 0; i < count; i++) {
    let x = 1 + rng.int(14);
    const h = 4 + rng.int(maxH - 3);
    const lean = rng.next() < 0.5 ? -1 : 1;
    for (let j = 0; j < h; j++) {
      const y = 15 - j;
      if (j > h * 0.6 && rng.next() < 0.4 * spread) x += lean;
      const v = 110 + j * (80 / h) + rng.int(20);
      p.set(x, y, color ? shade(color, v / 160) : grey(v));
    }
  }
}

function crop(p: Pixels, rng: Rng, stage: number, maxStage: number, ripe: C, topColor: C | null): void {
  p.clear();
  const t = stage / maxStage;
  const h = Math.round(3 + t * 11);
  const green = mix(hex("#4c9a2a"), hex("#6aa832"), t);
  for (const x0 of [2, 5, 8, 11, 14]) {
    let x = x0 + rng.int(2) - 1;
    for (let j = 0; j < h; j++) {
      const y = 15 - j;
      if (j === Math.floor(h / 2) && rng.next() < 0.5) x += rng.next() < 0.5 ? -1 : 1;
      let c = shade(green, 0.8 + (j / h) * 0.35);
      if (stage === maxStage && topColor === null && j > h - 5) c = shade(ripe, 0.85 + rng.next() * 0.3);
      p.set(x, y, c);
      if (j > h - 4 && stage === maxStage && topColor === null) p.set(x + 1, y, shade(ripe, 0.75));
    }
    if (topColor && stage === maxStage) {
      p.set(x, 15, topColor); p.set(x, 14, shade(topColor, 0.85));
    }
  }
}

// ---- helpers for faces ----------------------------------------------------------------

function woolPattern(p: Pixels, rng: Rng, c: C): void {
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const knit = ((x + y) % 4 === 0 ? 0.94 : 1) * ((x - y + 16) % 4 === 0 ? 0.97 : 1);
      p.set(x, y, shade(c, knit * (0.95 + rng.next() * 0.1)));
    }
  }
}

function metalBlock(p: Pixels, rng: Rng, c: C): void {
  noisy(p, rng, c, 0.06, 2);
  for (let i = 1; i < 15; i++) {
    p.set(i, 1, shade(c, 1.2)); p.set(1, i, shade(c, 1.15));
    p.set(i, 14, shade(c, 0.78)); p.set(14, i, shade(c, 0.8));
  }
  bevel(p, 1.25, 0.65);
}

function frame(p: Pixels, c: C, inset = 0): void {
  for (let i = inset; i < TEX - inset; i++) {
    p.set(i, inset, c); p.set(i, 15 - inset, c); p.set(inset, i, c); p.set(15 - inset, i, c);
  }
}

function rect(p: Pixels, x0: number, y0: number, x1: number, y1: number, c: C | ((x: number, y: number) => C), a = 255): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) p.set(x, y, typeof c === "function" ? c(x, y) : c, a);
}

// ---- block painters ----------------------------------------------------------------------

type Painter = (p: Pixels, rng: Rng) => void;
const PAINTERS: Record<string, Painter> = {};
const def = (name: string, painter: Painter) => { PAINTERS[name] = painter; };

const DIRT = [hex("#5d3f28"), hex("#6f4b31"), hex("#79553a"), hex("#866043"), hex("#946b4b")];
const OAK = hex("#a2824e"), BIRCH = hex("#c8b77a"), SPRUCE = hex("#735531"), JUNGLE = hex("#a0734d"), ACACIA = hex("#ad5d32");

def("stone", (p, r) => stone(p, r));
def("smooth_stone", (p, r) => { noisy(p, r, hex("#a0a0a0"), 0.06, 2); frame(p, hex("#8a8a8a")); });
def("dirt", (p, r) => palette(p, r, DIRT, 4, 0.55));
def("coarse_dirt", (p, r) => { palette(p, r, DIRT, 4, 0.55); speckle(p, r, [hex("#6d6a66"), hex("#8a8580")], 0.14); });
def("mud", (p, r) => palette(p, r, [hex("#2f2b2a"), hex("#3a3534"), hex("#433d3b"), hex("#4b4442")], 4, 0.5));
def("grass_block_top", (p, r) => {
  const n = valueNoise(r, 4);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) p.set(x, y, grey(118 + n[y * 16 + x] * 40 + r.int(26)));
});
def("grass_block_side", (p, r) => {
  palette(p, r, DIRT, 4, 0.55);
  for (let x = 0; x < TEX; x++) {
    const depth = 3 + r.int(2) + (r.next() < 0.25 ? 1 : 0);
    for (let y = 0; y < depth; y++) p.set(x, y, grey(120 + r.int(40)), 0);
  }
});
def("grass_block_snow", (p, r) => {
  palette(p, r, DIRT, 4, 0.55);
  for (let x = 0; x < TEX; x++) {
    const depth = 3 + r.int(2) + (r.next() < 0.3 ? 1 : 0);
    for (let y = 0; y < depth; y++) p.set(x, y, shade(hex("#f3fbfb"), 0.9 + r.next() * 0.1));
  }
});
def("podzol_top", (p, r) => { palette(p, r, [hex("#5a3d1c"), hex("#6b4a22"), hex("#7a5a2c"), hex("#8b6a38")], 4, 0.6); });
def("podzol_side", (p, r) => {
  palette(p, r, DIRT, 4, 0.55);
  for (let x = 0; x < TEX; x++) { const d = 3 + r.int(2); for (let y = 0; y < d; y++) p.set(x, y, r.pick([hex("#5a3d1c"), hex("#7a5a2c")])); }
});
def("moss_block", (p, r) => palette(p, r, [hex("#4d6424"), hex("#58702a"), hex("#627c30"), hex("#6d8a36")], 4, 0.5));
def("cobblestone", (p, r) => cobble(p, r, [hex("#8a8a8a"), hex("#7a7a7a"), hex("#6e6e6e"), hex("#9b9b9b")], hex("#4a4a4a")));
def("mossy_cobblestone", (p, r) => { cobble(p, r, [hex("#8a8a8a"), hex("#7a7a7a"), hex("#6e6e6e")], hex("#4a4a4a")); moss(p, r, 0.35); });
def("bedrock", (p, r) => palette(p, r, [hex("#1d1d1d"), hex("#3a3a3a"), hex("#565656"), hex("#7a7a7a"), hex("#9a9a9a")], 8, 0.9));
def("sand", (p, r) => palette(p, r, [hex("#cfc590"), hex("#d8cf9c"), hex("#dfd7a8"), hex("#e7e0b4")], 4, 0.6));
def("red_sand", (p, r) => palette(p, r, [hex("#a8531b"), hex("#b65e20"), hex("#c06828"), hex("#cb7432")], 4, 0.6));
def("gravel", (p, r) => palette(p, r, [hex("#5a5452"), hex("#6f6866"), hex("#857f7c"), hex("#9a9291"), hex("#aaa3a0")], 8, 0.9));
def("clay", (p, r) => noisy(p, r, hex("#a1a7b4"), 0.12, 4));
def("granite", (p, r) => { noisy(p, r, hex("#9a6a58"), 0.15, 4); speckle(p, r, [hex("#b98470"), hex("#7c5243"), hex("#c9a092")], 0.2); });
def("diorite", (p, r) => { noisy(p, r, hex("#bdbdbd"), 0.1, 4); speckle(p, r, [hex("#7b7b7b"), hex("#e2e2e2"), hex("#999")], 0.18); });
def("andesite", (p, r) => { noisy(p, r, hex("#878787"), 0.12, 4); speckle(p, r, [hex("#6c6c6c"), hex("#a3a3a3")], 0.2); });
def("calcite", (p, r) => { noisy(p, r, hex("#dddedb"), 0.06, 4); speckle(p, r, [hex("#c8c9c4"), hex("#eeeeea")], 0.12); });
def("tuff", (p, r) => { noisy(p, r, hex("#6c6d66"), 0.12, 4); speckle(p, r, [hex("#8a8b82"), hex("#55564f"), hex("#7c6f5c")], 0.18); });
def("polished_granite", (p, r) => polished(p, r, hex("#9a6a58")));
def("polished_diorite", (p, r) => polished(p, r, hex("#c3c3c5")));
def("polished_andesite", (p, r) => polished(p, r, hex("#838786")));
def("deepslate", (p, r) => deepslate(p, r));
def("deepslate_top", (p, r) => { noisy(p, r, hex("#4f4f54"), 0.22, 4); speckle(p, r, [hex("#3d3d42")], 0.15); });
def("cobbled_deepslate", (p, r) => cobble(p, r, [hex("#5a5a60"), hex("#4c4c52"), hex("#434348"), hex("#626268")], hex("#26262a")));
def("stone_bricks", (p, r) => bricksPattern(p, r, hex("#7c7c7c"), hex("#595959"), 8, 16));
def("mossy_stone_bricks", (p, r) => { bricksPattern(p, r, hex("#7c7c7c"), hex("#595959"), 8, 16); moss(p, r, 0.3); });
def("cracked_stone_bricks", (p, r) => {
  bricksPattern(p, r, hex("#777777"), hex("#555555"), 8, 16);
  let x = 3, y = 1;
  for (let i = 0; i < 14; i++) { p.set(x, y, hex("#3c3c3c")); y++; x += r.int(3) - 1; }
});
def("chiseled_stone_bricks", (p, r) => {
  noisy(p, r, hex("#7c7c7c"), 0.1, 4);
  for (let inset = 0; inset < 8; inset += 3) frame(p, shade(hex("#7c7c7c"), inset === 3 ? 0.7 : 1.15), inset);
  rect(p, 6, 6, 9, 9, hex("#6a6a6a"));
});
def("bricks", (p, r) => bricksPattern(p, r, hex("#955243"), hex("#b3aca2"), 4, 8));
def("obsidian", (p, r) => { palette(p, r, [hex("#0f0d16"), hex("#15121f"), hex("#1d1829"), hex("#2a2140")], 4, 0.6); speckle(p, r, [hex("#4b3a6b")], 0.04); });
def("sandstone", (p, r) => {
  noisy(p, r, hex("#d9cc9c"), 0.08, 4);
  for (let x = 0; x < 16; x++) { p.set(x, 0, hex("#e6dcb0")); p.set(x, 1, hex("#e1d6a6")); p.set(x, 2, hex("#c7b886")); p.set(x, 12, hex("#c7b886")); p.set(x, 15, hex("#c2b280")); }
});
def("sandstone_top", (p, r) => noisy(p, r, hex("#e0d6ab"), 0.08, 4));
def("sandstone_bottom", (p, r) => { noisy(p, r, hex("#d6c996"), 0.12, 4); speckle(p, r, [hex("#c4b584")], 0.2); });
const TERRACOTTA: Record<string, string> = {
  terracotta: "#985e43", orange_terracotta: "#a1531d", yellow_terracotta: "#ba8523", red_terracotta: "#8f3d2e",
  brown_terracotta: "#4d3323", white_terracotta: "#d1b2a1",
};
for (const [name, c] of Object.entries(TERRACOTTA)) def(name, (p, r) => noisy(p, r, hex(c), 0.07, 4));
def("snow", (p, r) => { noisy(p, r, hex("#f3fbfb"), 0.04, 4); speckle(p, r, [hex("#dcecee")], 0.12); });
def("ice", (p, r) => {
  noisy(p, r, hex("#86b2fb"), 0.08, 4);
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) p.data[(y * 16 + x) * 4 + 3] = 190;
  for (let i = 0; i < 4; i++) { const x = r.int(16), y = r.int(16); for (let j = 0; j < 4; j++) p.set(x + j, y - j, hex("#c7dcff"), 210); }
});
def("packed_ice", (p, r) => { noisy(p, r, hex("#8fb3f2"), 0.12, 4); speckle(p, r, [hex("#b8cff9")], 0.12); });

def("oak_planks", (p, r) => planks(p, r, OAK));
def("birch_planks", (p, r) => planks(p, r, BIRCH));
def("spruce_planks", (p, r) => planks(p, r, SPRUCE));
def("jungle_planks", (p, r) => planks(p, r, JUNGLE));
def("acacia_planks", (p, r) => planks(p, r, ACACIA));
def("oak_log", (p, r) => bark(p, r, hex("#6d5433"), hex("#4b3a22")));
def("spruce_log", (p, r) => bark(p, r, hex("#3d2b15"), hex("#2a1d0d")));
def("jungle_log", (p, r) => bark(p, r, hex("#56461e"), hex("#3e3210")));
def("acacia_log", (p, r) => bark(p, r, hex("#6a645b"), hex("#4d4841")));
def("birch_log", (p, r) => birchBark(p, r));
def("oak_log_top", (p, r) => logTop(p, r, OAK, hex("#6d5433")));
def("birch_log_top", (p, r) => logTop(p, r, BIRCH, hex("#d9d7cf")));
def("spruce_log_top", (p, r) => logTop(p, r, SPRUCE, hex("#3d2b15")));
def("jungle_log_top", (p, r) => logTop(p, r, JUNGLE, hex("#56461e")));
def("acacia_log_top", (p, r) => logTop(p, r, ACACIA, hex("#6a645b")));
for (const l of ["oak_leaves", "birch_leaves", "jungle_leaves", "acacia_leaves"]) def(l, (p, r) => leaves(p, r));
def("spruce_leaves", (p, r) => leaves(p, r, 0.3));

def("glass", (p, r) => {
  p.clear();
  const edge = hex("#dcf2f6");
  frame(p, edge);
  for (let i = 0; i < 16; i++) { p.set(i, 0, edge, 255); p.set(0, i, shade(edge, 0.9), 255); p.set(i, 15, shade(edge, 0.8), 255); p.set(15, i, shade(edge, 0.85), 255); }
  for (let j = 0; j < 4; j++) { p.set(3 + j, 6 - j, hex("#ffffff"), 170); p.set(4 + j, 6 - j, hex("#ffffff"), 110); }
  p.set(11, 12, hex("#ffffff"), 170); p.set(12, 11, hex("#ffffff"), 170);
});

const oreStone = (p: Pixels, r: Rng) => stone(p, r);
const oreDeep = (p: Pixels, r: Rng) => deepslate(p, r);
const ORES: Record<string, string[]> = {
  coal: ["#2b2b2b", "#3b3b3b", "#1a1a1a"],
  iron: ["#d8af93", "#c49a7c", "#e8c9b2"],
  gold: ["#fcee4b", "#e8c22a", "#fff7a8"],
  diamond: ["#5decf5", "#2bc7cf", "#d3fbff"],
  redstone: ["#ff1a1a", "#b30000", "#ff7070"],
  lapis: ["#2150b8", "#153a92", "#4e7ae0"],
  emerald: ["#17dd62", "#0a9a3f", "#8cf5b2"],
  copper: ["#e0734f", "#b35d3c", "#4dbf8a"],
};
for (const [k, cs] of Object.entries(ORES)) {
  def(`${k}_ore`, (p, r) => ore(p, r, oreStone, cs.map(hex)));
  def(`deepslate_${k}_ore`, (p, r) => ore(p, r, oreDeep, cs.map(hex)));
}

def("crafting_table_top", (p, r) => {
  planks(p, r, OAK);
  frame(p, hex("#5e4526"));
  for (let i = 1; i < 15; i++) { p.set(i, 5, hex("#6f5230")); p.set(i, 10, hex("#6f5230")); p.set(5, i, hex("#6f5230")); p.set(10, i, hex("#6f5230")); }
});
const tableSide = (p: Pixels, r: Rng, front: boolean) => {
  planks(p, r, OAK);
  rect(p, 0, 0, 15, 2, (x) => shade(hex("#8a6a3c"), x % 3 === 0 ? 0.85 : 1));
  if (front) {
    rect(p, 3, 5, 4, 12, hex("#7a7a7a")); rect(p, 2, 5, 5, 6, hex("#9a9a9a"));
    rect(p, 10, 5, 11, 12, hex("#5e4526")); rect(p, 8, 5, 13, 7, hex("#aaaaaa"));
  } else {
    rect(p, 4, 6, 11, 7, hex("#999999")); rect(p, 7, 8, 8, 13, hex("#5e4526"));
  }
};
def("crafting_table_side", (p, r) => tableSide(p, r, false));
def("crafting_table_front", (p, r) => tableSide(p, r, true));
const furnaceBase = (p: Pixels, r: Rng) => { noisy(p, r, hex("#6f6f6f"), 0.1, 4); bevel(p, 1.2, 0.7); };
def("furnace_top", (p, r) => { furnaceBase(p, r); rect(p, 3, 3, 12, 12, (x, y) => shade(hex("#5c5c5c"), 0.95 + ((x + y) % 2) * 0.05)); });
def("furnace_side", furnaceBase);
def("furnace_front", (p, r) => {
  furnaceBase(p, r);
  rect(p, 3, 8, 12, 13, hex("#1b1b1b"));
  rect(p, 3, 3, 12, 4, hex("#555555"));
  for (let x = 3; x <= 12; x++) p.set(x, 7, hex("#8a8a8a"));
});
def("furnace_front_on", (p, r) => {
  furnaceBase(p, r);
  rect(p, 3, 8, 12, 13, (x, y) => (y > 10 ? r.pick([hex("#ff9d00"), hex("#ffcc33"), hex("#ff6a00")]) : hex("#3a2008")));
  rect(p, 3, 3, 12, 4, hex("#555555"));
  for (let x = 3; x <= 12; x++) p.set(x, 7, hex("#8a8a8a"));
});
const chestWood = hex("#a26b2c");
def("chest_top", (p, r) => { planks(p, r, chestWood); frame(p, hex("#4e3310")); });
def("chest_side", (p, r) => { planks(p, r, chestWood); frame(p, hex("#4e3310")); for (let x = 0; x < 16; x++) p.set(x, 6, hex("#3b270c")); });
def("chest_front", (p, r) => {
  PAINTERS.chest_side(p, r);
  rect(p, 7, 4, 8, 8, hex("#c0c0c0")); p.set(7, 7, hex("#555")); p.set(8, 7, hex("#555"));
});
def("torch", (p) => {
  p.clear();
  rect(p, 7, 8, 8, 15, (x, y) => (x === 7 ? hex("#8a6a3a") : hex("#6b4e28")));
  p.set(7, 6, hex("#fff3b0")); p.set(8, 6, hex("#ffd84a"));
  p.set(7, 7, hex("#ffb52a")); p.set(8, 7, hex("#ff8c1a"));
  p.set(7, 5, hex("#fff8d0"), 200);
});
def("tnt_side", (p, r) => {
  noisy(p, r, hex("#db4a2c"), 0.08, 4);
  for (let x = 0; x < 16; x += 4) for (let y = 0; y < 16; y++) p.set(x, y, hex("#a33520"));
  rect(p, 0, 5, 15, 10, hex("#f2f2f2"));
  const T = ["###.#..#.###", ".#..##.#..#.", ".#..#.##..#.", ".#..#..#..#."];
  template(p, T.map((row) => "." + row), { "#": hex("#1a1a1a") }, 6);
});
def("tnt_top", (p, r) => { noisy(p, r, hex("#b8452c"), 0.08, 4); rect(p, 6, 6, 9, 9, hex("#7a7a7a")); rect(p, 7, 7, 8, 8, hex("#333")); });
def("tnt_bottom", (p, r) => noisy(p, r, hex("#b8452c"), 0.1, 4));
def("bookshelf", (p, r) => {
  planks(p, r, OAK);
  const books = ["#8e2b24", "#2e4f8a", "#3d7a2e", "#a07a2a", "#5b2d77", "#6b4a2b", "#1f6b6b"].map(hex);
  for (const [y0, y1] of [[1, 6], [9, 14]] as const) {
    let x = 1;
    while (x < 15) {
      const w = 1 + r.int(2);
      const c = r.pick(books);
      const top = y0 + r.int(2);
      rect(p, x, top, Math.min(14, x + w - 1), y1, (xx, yy) => shade(c, yy === top ? 1.2 : xx === x ? 1.05 : 0.9));
      x += w;
    }
  }
});
def("glowstone", (p, r) => { palette(p, r, [hex("#8a5a2a"), hex("#c48a3e"), hex("#f1c46a"), hex("#ffe9a8"), hex("#fff6d6")], 8, 0.8); });
def("sea_lantern", (p, r) => {
  noisy(p, r, hex("#bcd7cf"), 0.08, 4);
  for (let i = 0; i < 16; i++) { p.set(i, (i * 5) % 16, hex("#eaf6f1")); p.set((i * 7) % 16, i, hex("#f5fbf8")); }
  frame(p, hex("#8fb1a6"));
});
const METAL: Record<string, string> = {
  iron_block: "#d8d8d8", gold_block: "#f3d34a", diamond_block: "#63dfd8", emerald_block: "#3ccf6a",
  coal_block: "#1c1c1c", lapis_block: "#23499c", redstone_block: "#a8160b", copper_block: "#c06a4f",
  amethyst_block: "#8a64c2",
};
for (const [name, c] of Object.entries(METAL)) def(name, (p, r) => metalBlock(p, r, hex(c)));
const WOOL: Record<string, string> = {
  white: "#e9ecec", orange: "#f07613", magenta: "#bd44b3", light_blue: "#3aafd9", yellow: "#f8c627", lime: "#70b919",
  pink: "#ed8dac", gray: "#3e4447", light_gray: "#8e8e86", cyan: "#158991", purple: "#792aac", blue: "#35399d",
  brown: "#724728", green: "#546d1b", red: "#a12722", black: "#141519",
};
for (const [color, c] of Object.entries(WOOL)) def(`${color}_wool`, (p, r) => woolPattern(p, r, hex(c)));

const PUMPKIN = hex("#d17a1a");
def("pumpkin_side", (p, r) => {
  noisy(p, r, PUMPKIN, 0.1, 4);
  for (let y = 0; y < 16; y++) for (const x of [0, 4, 8, 12]) p.set(x, y, shade(PUMPKIN, 0.75));
});
def("pumpkin_top", (p, r) => {
  noisy(p, r, PUMPKIN, 0.1, 4);
  for (let i = 0; i < 16; i++) { p.set(i, 7, shade(PUMPKIN, 0.85)); p.set(7, i, shade(PUMPKIN, 0.85)); }
  rect(p, 6, 6, 9, 9, hex("#6b5a1e")); rect(p, 7, 7, 8, 8, hex("#4a7a22"));
});
const face = (p: Pixels, r: Rng, glow: boolean) => {
  PAINTERS.pumpkin_side(p, r);
  const hole = (x: number, y: number) => (glow ? (y % 2 ? hex("#ffd24a") : hex("#ffb000")) : hex("#2a1a05"));
  for (const [x, y] of [[3, 4], [4, 4], [3, 5], [4, 5], [5, 5], [11, 4], [12, 4], [10, 5], [11, 5], [12, 5]]) p.set(x, y, hole(x, y));
  rect(p, 3, 9, 12, 11, hole);
  p.set(5, 12, hole(5, 12)); p.set(9, 12, hole(9, 12)); p.set(6, 9, shade(PUMPKIN, 0.9)); p.set(10, 9, shade(PUMPKIN, 0.9));
};
def("carved_pumpkin", (p, r) => face(p, r, false));
def("jack_o_lantern", (p, r) => face(p, r, true));
def("melon_side", (p, r) => {
  noisy(p, r, hex("#6a9f2c"), 0.1, 4);
  for (let y = 0; y < 16; y++) for (const x of [1, 2, 6, 7, 11, 12]) p.set(x, y, shade(hex("#3f6b17"), 0.9 + r.next() * 0.2));
});
def("melon_top", (p, r) => {
  noisy(p, r, hex("#6a9f2c"), 0.1, 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (Math.round(Math.hypot(x - 7.5, y - 7.5)) % 4 === 0) p.set(x, y, hex("#3f6b17"));
});
def("farmland", (p, r) => {
  palette(p, r, [hex("#3f2716"), hex("#4b301c"), hex("#573a22"), hex("#634229")], 4, 0.5);
  for (let y = 0; y < 16; y += 4) for (let x = 0; x < 16; x++) p.set(x, y, hex("#2e1c0f"));
});
def("dirt_path_top", (p, r) => palette(p, r, [hex("#8a6f3a"), hex("#957a42"), hex("#a0864d"), hex("#aa9157")], 4, 0.5));
def("dirt_path_side", (p, r) => {
  palette(p, r, DIRT, 4, 0.55);
  for (let x = 0; x < 16; x++) for (let y = 1; y < 3; y++) p.set(x, y, hex("#957a42"));
});
for (let s = 0; s <= 7; s++) def(`wheat_stage_${s}`, (p, r) => crop(p, r, s, 7, hex("#c9a92c"), null));
for (let s = 0; s <= 3; s++) {
  def(`carrots_stage_${s}`, (p, r) => crop(p, r, s, 3, hex("#e3861a"), hex("#ef8a1c")));
  def(`potatoes_stage_${s}`, (p, r) => crop(p, r, s, 3, hex("#c7a254"), hex("#caa65a")));
}
const doorWood = hex("#9c7a45");
def("oak_door_bottom", (p, r) => {
  planks(p, r, doorWood);
  frame(p, hex("#6b5130"));
  rect(p, 3, 3, 12, 6, shade(doorWood, 0.85)); rect(p, 3, 9, 12, 13, shade(doorWood, 0.85));
  p.set(12, 1, hex("#3a3a3a")); p.set(13, 1, hex("#3a3a3a"));
});
def("oak_door_top", (p, r) => {
  planks(p, r, doorWood);
  frame(p, hex("#6b5130"));
  rect(p, 3, 3, 6, 7, hex("#000000"), 0); rect(p, 9, 3, 12, 7, hex("#000000"), 0);
  rect(p, 3, 10, 12, 13, shade(doorWood, 0.85));
  p.set(12, 14, hex("#3a3a3a")); p.set(13, 14, hex("#3a3a3a"));
});
def("ladder", (p, r) => {
  p.clear();
  const wood = hex("#8a6a3a");
  for (let y = 0; y < 16; y++) { p.set(2, y, wood); p.set(3, y, shade(wood, 0.8)); p.set(12, y, wood); p.set(13, y, shade(wood, 0.8)); }
  for (const y of [1, 5, 9, 13]) for (let x = 4; x < 12; x++) { p.set(x, y, shade(wood, 1.05)); p.set(x, y + 1, shade(wood, 0.75)); }
});
const RED = hex("#a12722");
def("bed_foot_top", (p, r) => { woolPattern(p, r, RED); frame(p, shade(RED, 0.8)); });
def("bed_head_top", (p, r) => {
  woolPattern(p, r, RED);
  rect(p, 2, 1, 13, 6, (x, y) => shade(hex("#eeeeee"), 0.92 + r.next() * 0.08));
  frame(p, shade(RED, 0.8));
});
def("bed_side", (p, r) => {
  planks(p, r, OAK);
  rect(p, 0, 7, 15, 11, (x) => shade(RED, 0.9 + (x % 3) * 0.05));
  rect(p, 0, 14, 15, 15, hex("#5a3d1f"));
});
def("bed_head_side", (p, r) => {
  PAINTERS.bed_side(p, r);
  rect(p, 0, 7, 3, 9, hex("#e8e8e8"));
});
def("lantern", (p) => {
  p.clear();
  const iron = hex("#3d424a");
  rect(p, 5, 9, 10, 15, iron);
  rect(p, 6, 10, 9, 14, (x, y) => (y % 2 ? hex("#ffd36b") : hex("#ffb83a")));
  rect(p, 6, 7, 9, 8, shade(iron, 1.2));
  rect(p, 6, 6, 9, 6, iron);
});
def("lantern_item", (p) => {
  p.clear();
  const iron = hex("#3d424a");
  rect(p, 5, 6, 10, 14, iron);
  rect(p, 6, 7, 9, 13, (x, y) => (y % 2 ? hex("#ffd36b") : hex("#ffb83a")));
  rect(p, 6, 4, 9, 5, shade(iron, 1.2)); rect(p, 7, 2, 8, 3, iron);
});
def("hay_block_side", (p, r) => {
  const n = valueNoise(r, 8, 2);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) p.set(x, y, shade(hex("#c3a034"), 0.85 + n[y * 16 + x] * 0.3));
  for (const y of [2, 3, 12, 13]) for (let x = 0; x < 16; x++) p.set(x, y, shade(hex("#8a3f1e"), y % 2 ? 0.8 : 1));
});
def("hay_block_top", (p, r) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    p.set(x, y, shade(hex("#b89535"), 0.85 + (Math.floor(d) % 3 === 0 ? 0.2 : 0) + r.next() * 0.1));
  }
});
def("lily_pad", (p, r) => {
  p.clear();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    const notch = x > 7 && Math.abs(y - 7.5) < (x - 7) * 0.4;
    if (d < 7 && !notch) p.set(x, y, grey(110 + r.int(50) + (d < 2 ? 20 : 0)));
  }
});
def("cactus_side", (p, r) => {
  p.clear();
  noisy(p, r, hex("#107d21"), 0.12, 4);
  for (let y = 0; y < 16; y++) { p.set(0, y, hex("#000"), 0); p.set(15, y, hex("#000"), 0); }
  for (let y = 0; y < 16; y++) for (const x of [4, 11]) p.set(x, y, hex("#0b5c17"));
  for (let i = 0; i < 6; i++) p.set(1 + r.int(14), r.int(16), hex("#d8d2a0"));
});
def("cactus_top", (p, r) => {
  noisy(p, r, hex("#139325"), 0.1, 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)) > 6.5) p.set(x, y, hex("#0b5c17"));
  rect(p, 6, 6, 9, 9, hex("#1fa332"));
});
def("cactus_bottom", (p, r) => noisy(p, r, hex("#b5c77f"), 0.1, 4));
def("short_grass", (p, r) => blades(p, r, 11, 13, null));
def("fern", (p, r) => {
  p.clear();
  for (const [x0, lean] of [[4, -1], [8, 0], [11, 1]] as const) {
    let x = x0;
    for (let y = 15; y > 3; y--) {
      p.set(x, y, grey(120 + (15 - y) * 5));
      if (y % 2 === 0) { p.set(x - 1, y, grey(140)); p.set(x + 1, y, grey(130)); }
      if (y % 4 === 0) x += lean;
    }
  }
});
def("dead_bush", (p, r) => {
  p.clear();
  const c = hex("#6b4a23");
  for (const [x0, dx] of [[7, -1], [8, 1], [7, 0]] as const) {
    let x = x0;
    for (let y = 15; y > 5; y--) { p.set(x, y, shade(c, 0.9 + r.next() * 0.3)); if (y % 3 === 0) x += dx; }
  }
});
def("sugar_cane", (p, r) => {
  p.clear();
  for (const x of [3, 7, 11]) for (let y = 0; y < 16; y++) {
    p.set(x, y, grey(y % 5 === 0 ? 110 : 160)); p.set(x + 1, y, grey(y % 5 === 0 ? 100 : 135));
  }
  p.set(5, 4, grey(150)); p.set(9, 9, grey(150)); p.set(13, 2, grey(150));
});
def("dandelion", (p, r) => flower(p, r, hex("#ffec4f"), hex("#f2b822"), "round"));
def("poppy", (p, r) => flower(p, r, hex("#e0241c"), hex("#2a1a0a"), "round"));
def("blue_orchid", (p, r) => flower(p, r, hex("#2eb0e8"), hex("#1f86c4"), "bells"));
def("allium", (p, r) => flower(p, r, hex("#b865e6"), hex("#8a3fbf"), "ball"));
def("cornflower", (p, r) => flower(p, r, hex("#4a6be8"), hex("#2a3fb0"), "tall"));
def("oxeye_daisy", (p, r) => flower(p, r, hex("#f2f2f2"), hex("#e8c229"), "round"));
def("red_tulip", (p, r) => flower(p, r, hex("#e8392b"), hex("#b3261c"), "tulip"));
def("lily_of_the_valley", (p, r) => flower(p, r, hex("#fbfbfb"), hex("#e0e0e0"), "bells"));
def("brown_mushroom", (p) => {
  p.clear();
  rect(p, 7, 10, 8, 14, hex("#d8cfb8"));
  rect(p, 4, 7, 11, 9, (x) => shade(hex("#9a6b4b"), x < 6 ? 1.1 : 0.95));
  rect(p, 5, 6, 10, 6, hex("#b07e5b"));
});
def("red_mushroom", (p) => {
  p.clear();
  rect(p, 7, 10, 8, 14, hex("#e0d7c4"));
  rect(p, 4, 6, 11, 9, hex("#d6261c"));
  rect(p, 5, 5, 10, 5, hex("#e03a2c"));
  for (const [x, y] of [[5, 7], [9, 6], [7, 8], [10, 8]]) p.set(x, y, hex("#f5f5f5"));
});
def("oak_sapling", (p, r) => sapling(p, r, hex("#4c8a2a"), hex("#6d5433")));
def("birch_sapling", (p, r) => sapling(p, r, hex("#79a64f"), hex("#d9d7cf")));
def("spruce_sapling", (p, r) => sapling(p, r, hex("#35573a"), hex("#3d2b15")));
def("jungle_sapling", (p, r) => sapling(p, r, hex("#3f8f1f"), hex("#56461e")));
def("acacia_sapling", (p, r) => sapling(p, r, hex("#6d8f2a"), hex("#6a645b")));
def("cobweb", (p) => {
  p.clear();
  const w = hex("#f0f0f0");
  for (let i = 0; i < 16; i++) { p.set(i, i, w, 220); p.set(15 - i, i, w, 220); p.set(7, i, w, 200); p.set(i, 7, w, 200); }
  for (const r0 of [3, 6]) for (let a = 0; a < 16; a++) {
    const t = (a / 16) * Math.PI * 2;
    p.set(Math.round(7.5 + Math.cos(t) * r0), Math.round(7.5 + Math.sin(t) * r0), w, 180);
  }
});
def("note_block", (p, r) => { planks(p, r, hex("#5c3b28")); frame(p, hex("#3a2518")); rect(p, 6, 6, 9, 9, hex("#2b1b12")); });

// Particles, sun and moon.
def("particle_smoke", (p) => {
  p.clear();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d < 6.5) p.set(x, y, grey(200 - d * 8), Math.round(255 * (1 - d / 7)));
  }
});
def("particle_heart", (p) => {
  p.clear();
  template(p, [
    "................", "................", "................",
    "...aaa....aaa...",
    "..arrra..arrra..",
    ".arwrrrraarrrra.",
    ".arrrrrrrrrrrra.",
    ".arrrrrrrrrrrra.",
    "..arrrrrrrrrra..",
    "...arrrrrrrra...",
    "....arrrrrra....",
    ".....arrrra.....",
    "......arra......",
    ".......aa.......",
  ], { a: hex("#5a0a0a"), r: hex("#e8262a"), w: hex("#ffb3b3") });
});
def("particle_flame", (p) => {
  p.clear();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot((x - 7.5) * 1.3, (y - 9) * 0.9);
    if (d < 6.5) p.set(x, y, mix(hex("#fff3a0"), hex("#ff6a00"), d / 6.5));
  }
});
def("particle_spark", (p) => {
  p.clear();
  for (let i = 0; i < 16; i++) { p.set(i, 7, hex("#ffffff")); p.set(7, i, hex("#ffffff")); p.set(i, 8, hex("#ffffff")); p.set(8, i, hex("#ffffff")); }
});
def("particle_bubble", (p) => {
  p.clear();
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d < 6.5 && d > 4.8) p.set(x, y, hex("#dff4ff"));
    if (d < 2 && x < 7 && y < 7) p.set(x, y, hex("#ffffff"));
  }
});
def("particle_note", (p) => {
  p.clear();
  template(p, [
    "................", "................",
    ".........aaaa...",
    ".........awwa...",
    ".........a..a...",
    ".........a..a...",
    ".........a..a...",
    ".........a..a...",
    "......aaaa..a...",
    ".....awwwa.aa...",
    ".....awwwaawwa..",
    "......aaa.awwa..",
    "...........aa...",
  ], { a: hex("#1a1a1a"), w: hex("#ffffff") });
});
def("sun", (p) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
    if (d < 4) p.set(x, y, hex("#fffbe0"));
    else if (d < 6) p.set(x, y, hex("#ffe98a"), 200);
    else p.set(x, y, hex("#ffd24a"), Math.round(Math.max(0, 1 - (d - 6) / 2) * 90));
  }
});
def("moon", (p, r) => {
  p.clear();
  for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) p.set(x, y, shade(hex("#e8ecf2"), 0.9 + r.next() * 0.1));
  for (const [x, y] of [[5, 5], [9, 7], [6, 10], [10, 11]]) { p.set(x, y, hex("#b8c0cc")); p.set(x + 1, y, hex("#c8ced8")); }
});

// Water and lava are animated: ANIM_FRAMES consecutive layers, painted from a
// looping path through 3D noise so the last frame flows into the first.
const WATER_NOISE = new Simplex(4242);
const LAVA_NOISE = new Simplex(9191);
function fluidFrame(p: Pixels, frame: number, lava: boolean): void {
  const t = (frame / ANIM_FRAMES) * Math.PI * 2;
  const n = lava ? LAVA_NOISE : WATER_NOISE;
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const ax = (x / 16) * Math.PI * 2, ay = (y / 16) * Math.PI * 2;
      // Sampling on circles makes the pattern tile in x, y and time.
      const v = n.noise3(Math.cos(ax) * 0.9 + Math.cos(t) * 0.6, Math.sin(ax) * 0.9 + Math.cos(ay) * 0.9, Math.sin(ay) * 0.9 + Math.sin(t) * 0.6);
      const f = (v + 1) / 2;
      if (lava) {
        p.set(x, y, mix(hex("#c2410c"), hex("#ffd35a"), Math.pow(f, 1.4)));
      } else {
        const g = 150 + f * 70;
        p.set(x, y, [g, g, g], 175 + Math.round(f * 30));
      }
    }
  }
}

// Mining crack overlays, ten stages, drawn over the block being broken.
function destroyStage(p: Pixels, stage: number): void {
  p.clear();
  const rng = new Rng(777);
  const lines = 2 + stage * 2;
  for (let i = 0; i < lines; i++) {
    let x = 8 + rng.int(3) - 1, y = 8 + rng.int(3) - 1;
    const dx = rng.next() * 2 - 1, dy = rng.next() * 2 - 1;
    const len = 3 + stage + rng.int(3);
    for (let j = 0; j < len; j++) {
      p.set(Math.round(x), Math.round(y), grey(20), 200);
      x += dx + (rng.next() - 0.5) * 0.8;
      y += dy + (rng.next() - 0.5) * 0.8;
    }
  }
}

// ---- items ------------------------------------------------------------------------------

type ItemPalette = Record<string, C>;
const H = hex("#6b4a26"), HD = hex("#46301a"), HL = hex("#8a6536");
const ITEM_TEMPLATES: Record<string, string[]> = {
  pickaxe: [
    "................",
    "....aaaaaa......",
    "..aacbbbbbaa....",
    ".abccbbbbbbba...",
    ".aaaaaaahbbba...",
    "........ahbbba..",
    ".......ahh.aba..",
    "......ahh...aba.",
    ".....ahh.....aa.",
    "....ahh.........",
    "...ahh..........",
    "..ahh...........",
    ".ahh............",
    ".aa.............",
  ],
  axe: [
    "................",
    ".......aaa......",
    "......acbba.....",
    ".....acbbbba....",
    "....aabbbbbba...",
    "....abbhbbba....",
    ".....aahhba.....",
    "......ahh.......",
    ".....ahh........",
    "....ahh.........",
    "...ahh..........",
    "..ahh...........",
    ".ahh............",
    ".aa.............",
  ],
  shovel: [
    "................",
    "...........aaa..",
    "..........acbba.",
    ".........acbbba.",
    "..........bbba..",
    "........ahaaa...",
    ".......ahh......",
    "......ahh.......",
    ".....ahh........",
    "....ahh.........",
    "...ahh..........",
    "..ahh...........",
    ".ahh............",
    ".aa.............",
  ],
  hoe: [
    "................",
    ".......aaaaa....",
    "......acbbbba...",
    "......aaaahba...",
    ".........ahaa...",
    "........ahh.....",
    ".......ahh......",
    "......ahh.......",
    ".....ahh........",
    "....ahh.........",
    "...ahh..........",
    "..ahh...........",
    ".ahh............",
    ".aa.............",
  ],
  sword: [
    "................",
    ".............aa.",
    "............acba",
    "...........acba.",
    "..........acba..",
    ".........acba...",
    "........acba....",
    ".......acba.....",
    "..aa..acba......",
    "..abaacba.......",
    "...abba.........",
    "...ahbba........",
    "..ahh.aba.......",
    ".ahh...aa.......",
    ".aa.............",
  ],
  helmet: [
    "................",
    "................",
    "................",
    "....aaaaaaaa....",
    "...abccbbbbbba..",
    "..abcbbbbbbbbda.",
    "..abbbbbbbbbbda.",
    "..abbaaaaaaabda.",
    "..abba......bda.",
    "..aaa.......aaa.",
  ],
  chestplate: [
    "................",
    "..aaa......aaa..",
    ".abca......abda.",
    ".abbbaaaaaabbda.",
    ".abcbbbbbbbbbda.",
    "..aabbbbbbbbaa..",
    "...abcbbbbbda...",
    "...abbbbbbbda...",
    "...abcbbbbbda...",
    "...abbbbbbbda...",
    "...abbbbbbbda...",
    "...aaaaaaaaaa...",
  ],
  leggings: [
    "................",
    "...aaaaaaaaaa...",
    "...abcbbbbbda...",
    "...abbbbbbbda...",
    "...abbbaabbda...",
    "...abcda.abda...",
    "...abbda.abda...",
    "...abbda.abda...",
    "...abcda.abda...",
    "...abbda.abda...",
    "...aaaa..aaaa...",
  ],
  boots: [
    "................",
    "................",
    "................",
    "................",
    "...aaaa..aaaa...",
    "...abca..acba...",
    "...abba..abba...",
    "...abba..abba...",
    "..abbba..abbba..",
    "..acbbda.acbbda.",
    "..aaaaaa.aaaaaa.",
  ],
  nugget: [
    "................", "................", "................", "................", "................", "................",
    "......aaa.......",
    ".....acbba......",
    "....acbbbda.....",
    "....abbbdda.....",
    ".....addda......",
    "......aaa.......",
  ],
  ingot: [
    "................", "................", "................", "................", "................",
    "......aaaaaaaa..",
    ".....acccccccba.",
    "....acbbbbbbbda.",
    "...acbbbbbbbda..",
    "..aaaaaaaaaaa...",
    "..abbbbbbbbda...",
    "..aaaaaaaaaa....",
  ],
  raw: [
    "................", "................", "................",
    "......aaaa......",
    "....aacbbba.....",
    "...acbbbbbbaa...",
    "...abbdbbcbbba..",
    "..acbbbbbbbbda..",
    "..abbbcbbdbbda..",
    "..abdbbbbbbda...",
    "...abbbbbdda....",
    "....aaaaaaa.....",
  ],
  gem: [
    "................", "................", "................",
    ".....aaaaaa.....",
    "....acccbbba....",
    "...acbbbbbbba...",
    "..acbbcbbbbbda..",
    "..abbbbbbbbbda..",
    "...abbbbbbbda...",
    "....abbbbbda....",
    ".....abbbda.....",
    "......abda......",
    ".......aa.......",
  ],
  emerald: [
    "................", "................",
    ".......aa.......",
    "......acba......",
    ".....acbbba.....",
    "....acbbbbda....",
    "....abcbbbda....",
    "....abbbbbda....",
    "....abbbbbda....",
    "....abbbbdda....",
    ".....abbbda.....",
    "......abda......",
    ".......aa.......",
  ],
  lump: [
    "................", "................", "................", "................",
    ".....aaaaa......",
    "....abcbbba.....",
    "...abcbbbbbaa...",
    "..abbbbbdbbbba..",
    "..acbbbbbbbbda..",
    "..abbdbbbbbbda..",
    "...abbbbbbdda...",
    "....aaaaaaaa....",
  ],
  dust: [
    "................", "................", "................", "................", "................",
    "........b.......",
    ".....b.bcb......",
    "....bcbbbbb.b...",
    "...bbbcbbdbbcb..",
    "..bbcbbbbbbbbbb.",
    ".bbbbbdbbcbbdbb.",
    "..bdbbbbbbbdbb..",
  ],
  dye: [
    "................", "................", "................", "................",
    "......aaaa......",
    ".....acbbba.....",
    "....acbbbbba....",
    "....abcbbbda....",
    "....abbbbbda....",
    ".....abbbda.....",
    "......aaaa......",
  ],
  stick: [
    "................", "................", "................", "................",
    "...........ab...",
    "..........abd...",
    ".........abd....",
    "........abd.....",
    ".......abd......",
    "......abd.......",
    ".....abd........",
    "....abd.........",
    "....ad..........",
  ],
  bucket: [
    "................", "................", "................",
    "...aaaaaaaaaa...",
    "..affffffffffa..",
    "..acffffffffba..",
    "..abaaaaaaaada..",
    "...abcbbbbbda...",
    "...abbbbbbbda...",
    "...abcbbbbbda...",
    "....abbbbbda....",
    "....aaaaaaaa....",
  ],
  apple: [
    "................", "................",
    ".......h........",
    "........hgg.....",
    ".....aaahaa.....",
    "....acbbabbba...",
    "...acbbbbbbbda..",
    "...abcbbbbbbda..",
    "...abbbbbbbbda..",
    "...abbbbbbbdda..",
    "....abbbbbdda...",
    ".....aabaaa.....",
  ],
  meat: [
    "................", "................", "................", "................",
    "......aaaaa.....",
    "....aacbbbbaa...",
    "...acbbbcbbbba..",
    "..acbbbbbbbbbda.",
    "..abbdbbbbbbbda.",
    "..abbbbbbcbbda..",
    "..aewbbbbbbda...",
    "..aewwaaaaaa....",
    "...aa...........",
  ],
  drumstick: [
    "................", "................", "................",
    ".......aaaa.....",
    ".....aacbbba....",
    "....acbbbbbba...",
    "....abbbcbbda...",
    "....abbbbbbda...",
    ".....abbbbda....",
    "......abbda.....",
    ".....aewa.......",
    "....aewwa.......",
    "....aaaa........",
  ],
  bread: [
    "................", "................", "................", "................", "................",
    "......aaaaaa....",
    "....aacbcbcbaa..",
    "...acbbbbbbbbba.",
    "..acbcbcbcbbbda.",
    "..abbbbbbbbbdda.",
    "...addddddddda..",
    "....aaaaaaaaa...",
  ],
  carrot: [
    "................",
    "..........g.g...",
    "...........gg...",
    ".........aagga..",
    "........acbba...",
    ".......acbbda...",
    "......acbbda....",
    ".....acbdba.....",
    "....acbbda......",
    "...abbbda.......",
    "..abbda.........",
    "..ada...........",
    "..a.............",
  ],
  potato: [
    "................", "................", "................", "................",
    ".....aaaaa......",
    "....acbbbbaa....",
    "...acbbdbbbba...",
    "..acbbbbbbdbba..",
    "..abbbdbbbbbda..",
    "...abbbbbbbda...",
    "....aabbbdaa....",
    "......aaaa......",
  ],
  seeds: [
    "................", "................", "................", "................", "................",
    "......b....b....",
    "...b.....b......",
    ".....b.b....b...",
    "..b.......b.....",
    "......b.b...b...",
    "....b.....b.....",
    "........b.......",
  ],
  wheat: [
    "................",
    "...........bb...",
    "..........bcb.b.",
    "........b.bbcb..",
    ".......bcbbcb...",
    "......bcbbb.b...",
    ".....bbcbb......",
    "....bgbb........",
    "...bgg..........",
    "..ggg...........",
    ".gg.............",
    "gg..............",
  ],
  feather: [
    "................",
    "...........aa...",
    "..........acba..",
    ".........acbba..",
    "........acbbda..",
    ".......acbbda...",
    "......acbbda....",
    ".....acbbda.....",
    "....acbbda......",
    "...abbbda.......",
    "...ahdda........",
    "..ah.aa.........",
    ".ah.............",
  ],
  string: [
    "................", "................",
    "..........bb....",
    ".........b..b...",
    "........b...b...",
    ".......b...b....",
    "......b...b.....",
    ".....b...b......",
    "....b...b.......",
    "...b..bb........",
    "...bbb..........",
  ],
  bone: [
    "................", "................",
    "...........aa...",
    "..........acba..",
    ".........acbba..",
    "........acbda...",
    ".......acbda....",
    "......acbda.....",
    ".....acbda......",
    "....acbda.......",
    "...acbba........",
    "...abba.........",
    "....aa..........",
  ],
  leather: [
    "................", "................", "................",
    "....aaaaaaaa....",
    "...acbbbbbbba...",
    "..acbbcbbbbbba..",
    "..abbbbbbbdbba..",
    "..abbdbbbbbbda..",
    "...abbbbbbbda...",
    "..acbbbbbbbbba..",
    "..abbbbbdbbbda..",
    "...aaaaaaaaaa...",
  ],
  flint: [
    "................", "................", "................",
    ".......aa.......",
    "......acba......",
    ".....acbbda.....",
    "....acbbbbda....",
    "....abcbbbda....",
    "...acbbbbbbda...",
    "...abbbbbbdda...",
    "....aaaaaaaa....",
  ],
  paper: [
    "................", "................",
    "..aaaaaaaaaaaa..",
    "..abbbbbbbbbba..",
    "..abddddddddba..",
    "..abbbbbbbbbba..",
    "..abdddddddbba..",
    "..abbbbbbbbbba..",
    "..abddddddddba..",
    "..abbbbbbbbbba..",
    "..abdddddbbbba..",
    "..abbbbbbbbbba..",
    "..aaaaaaaaaaaa..",
  ],
  book: [
    "................", "................",
    "...aaaaaaaaaa...",
    "..abbbbbbbbbba..",
    "..abcccccccbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..abbbbbbbbbba..",
    "..awwwwwwwwwwa..",
    "..aaaaaaaaaaaa..",
  ],
  ball: [
    "................", "................", "................", "................",
    "......aaaa......",
    ".....acbbba.....",
    "....acbbbbba....",
    "....abcbbbda....",
    "....abbbbbda....",
    ".....abbdda.....",
    "......aaaa......",
  ],
  egg: [
    "................", "................", "................",
    "......aaa.......",
    ".....acbba......",
    "....acbbbba.....",
    "....abcbbbda....",
    "...abbbbbbbda...",
    "...abbbbbbbda...",
    "....abbbbbda....",
    ".....aaaaaa.....",
  ],
  eye: [
    "................", "................", "................", "................",
    ".....aaaaaa.....",
    "....acbbbbba....",
    "...abbbddbbba...",
    "...abbdwwdbba...",
    "...abbdwwdbba...",
    "....abbddbba....",
    ".....aaaaaa.....",
  ],
  melon_slice: [
    "................", "................", "................", "................", "................",
    "..a..........a..",
    "..aa........aa..",
    "..abbbbbbbbbba..",
    "...abwbbwbbba...",
    "....abbbbbba....",
    ".....gggggg.....",
    "......gggg......",
  ],
  pie: [
    "................", "................", "................", "................", "................",
    "....aaaaaaaa....",
    "..aacbcbcbcbaa..",
    ".acbbbbbbbbbbba.",
    ".abbcbbbcbbbbda.",
    ".addddddddddda..",
    "..aaaaaaaaaaa...",
  ],
  bowl: [
    "................", "................", "................", "................", "................", "................",
    "..aaaaaaaaaaaa..",
    "..abffffffffba..",
    "...abbbbbbbda...",
    "....abbbbbda....",
    ".....aaaaaa.....",
  ],
  bow: [
    "................",
    "..........aaa...",
    ".........abba...",
    "........abha.s..",
    ".......aba..s...",
    "......aba..s....",
    ".....aba..s.....",
    "....aba..s......",
    "...aba..s.......",
    "..aha..s........",
    ".aba..s.........",
    ".aba.s..........",
    ".aaas...........",
  ],
  arrow: [
    "................",
    "...........aaa..",
    "...........abba.",
    "..........ahbba.",
    ".........ahha...",
    "........ahh.....",
    ".......ahh......",
    "......ahh.......",
    ".....ahh........",
    "..wwahh.........",
    "..wahh..........",
    "..wwa...........",
    "..ww............",
  ],
  flint_and_steel: [
    "................", "................",
    "..aaaaaa........",
    "..abbbba........",
    "..abaaba........",
    "..aba.aba.......",
    "..aba..aa.......",
    "..aa..fff.......",
    ".......fffa.....",
    "........fdda....",
    ".........fda....",
    "..........aa....",
  ],
  shears: [
    "................", "................",
    "...........aa...",
    "..........abba..",
    ".........abba...",
    "..aa....abba....",
    "..abaa.abba.....",
    "...abbabba......",
    "....abba........",
    "...rra.rr.......",
    "..rr..rrr.......",
    "..rr..rr........",
    "...rrr..........",
  ],
  door: [
    "................",
    ".....aaaaaa.....",
    ".....abbbba.....",
    ".....a.ba.a.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....abcbba.....",
    ".....abbbwa.....",
    ".....abbbba.....",
    ".....abcbba.....",
    ".....abbbba.....",
    ".....abbbba.....",
    ".....aaaaaa.....",
  ],
  bed: [
    "................", "................", "................", "................", "................",
    "..wwwrrrrrrrrr..",
    "..wwwrrrrrrrrr..",
    ".abbbbbbbbbbbba.",
    ".aa..........aa.",
  ],
  stew: [
    "................", "................", "................", "................", "................",
    "..aaaaaaaaaaaa..",
    "..abssssssssba..",
    "..abssmsssmsba..",
    "...abbbbbbbda...",
    "....abbbbbda....",
    ".....aaaaaa.....",
  ],
  flesh: [
    "................", "................", "................", "................",
    ".....aaaaa......",
    "...aacbbdba.....",
    "..acbbdbbbbaa...",
    "..abdbbbcbdbba..",
    "..abbbbdbbbbda..",
    "...abdbbbbdda...",
    "....aaaaaaaa....",
  ],
};

function toolPalette(head: string): ItemPalette {
  const c = hex(head);
  return { a: shade(c, 0.45), b: c, c: shade(c, 1.35), d: shade(c, 0.7), h: H, H: HD };
}

function paletteOf(main: string, extra: ItemPalette = {}): ItemPalette {
  const c = hex(main);
  return { a: shade(c, 0.45), b: c, c: shade(c, 1.3), d: shade(c, 0.72), ...extra };
}

const TOOL_HEADS: Record<string, string> = {
  wooden: "#8a6a3a", stone: "#8a8a8a", iron: "#dcdcdc", golden: "#f5d84a", diamond: "#4ce2e0",
};
const ARMOR_COLORS: Record<string, string> = { leather: "#8f5a33", iron: "#d8d8d8", golden: "#f5d84a", diamond: "#4ce2e0" };
const DYE_COLORS: Record<string, string> = {
  white: "#f0f0f0", red: "#b02e26", yellow: "#fed83d", blue: "#3c44aa", green: "#5e7c16", orange: "#f9801d",
  purple: "#8932b8", black: "#1d1d21",
};

interface ItemArt { template: string; palette: ItemPalette }
const ITEM_ART: Record<string, ItemArt> = {};
const art = (name: string, template: string, pal: ItemPalette) => { ITEM_ART[name] = { template, palette: pal }; };

for (const [tier, color] of Object.entries(TOOL_HEADS)) {
  for (const tool of ["pickaxe", "axe", "shovel", "hoe", "sword"]) art(`${tier}_${tool}`, tool, toolPalette(color));
}
for (const [mat, color] of Object.entries(ARMOR_COLORS)) {
  for (const piece of ["helmet", "chestplate", "leggings", "boots"]) art(`${mat}_${piece}`, piece, paletteOf(color));
}
for (const [dye, color] of Object.entries(DYE_COLORS)) art(`${dye}_dye`, "dye", paletteOf(color));
art("iron_ingot", "ingot", paletteOf("#d8d8d8"));
art("gold_ingot", "ingot", paletteOf("#f5d84a"));
art("copper_ingot", "ingot", paletteOf("#d97a4f"));
art("brick", "ingot", paletteOf("#a3533f"));
art("iron_nugget", "nugget", paletteOf("#d8d8d8"));
art("gold_nugget", "nugget", paletteOf("#f5d84a"));
art("raw_iron", "raw", paletteOf("#c9a88f"));
art("raw_gold", "raw", paletteOf("#e8c03a"));
art("raw_copper", "raw", paletteOf("#c46b45"));
art("diamond", "gem", paletteOf("#4ce2e0"));
art("lapis_lazuli", "gem", paletteOf("#2c5ac4"));
art("emerald", "emerald", paletteOf("#17c75a"));
art("coal", "lump", paletteOf("#2e2e2e", { c: hex("#5a5a5a") }));
art("charcoal", "lump", paletteOf("#3a2e25", { c: hex("#5c4a3c") }));
art("redstone", "dust", paletteOf("#c9170b"));
art("glowstone_dust", "dust", paletteOf("#f0c060"));
art("gunpowder", "dust", paletteOf("#5a5a5a"));
art("sugar", "dust", paletteOf("#f2f2f2"));
art("bone_meal", "dust", paletteOf("#e8e6da"));
art("stick", "stick", { a: HD, b: H, d: HD });
art("bucket", "bucket", paletteOf("#b8b8b8", { f: shade(hex("#b8b8b8"), 0.35) }));
art("water_bucket", "bucket", paletteOf("#b8b8b8", { f: hex("#3a6ee8") }));
art("lava_bucket", "bucket", paletteOf("#b8b8b8", { f: hex("#ff8a1a") }));
art("milk_bucket", "bucket", paletteOf("#b8b8b8", { f: hex("#f7f7f7") }));
art("apple", "apple", paletteOf("#d6241c", { h: H, g: hex("#4c9a2a") }));
art("golden_apple", "apple", paletteOf("#f5d84a", { h: H, g: hex("#4c9a2a") }));
art("porkchop", "meat", paletteOf("#f2a0a0", { e: hex("#f5e8e0"), w: hex("#fff") }));
art("cooked_porkchop", "meat", paletteOf("#c8845a", { e: hex("#e8d8c0"), w: hex("#f5f0e0") }));
art("beef", "meat", paletteOf("#c9392e", { e: hex("#f5e8e0"), w: hex("#fff") }));
art("cooked_beef", "meat", paletteOf("#7a4a2a", { e: hex("#d8c8b0"), w: hex("#eee") }));
art("mutton", "meat", paletteOf("#d44a40", { e: hex("#f5e8e0"), w: hex("#fff") }));
art("cooked_mutton", "meat", paletteOf("#8c5230", { e: hex("#d8c8b0"), w: hex("#eee") }));
art("chicken", "drumstick", paletteOf("#f2c6b0", { e: hex("#f5e8e0"), w: hex("#fff") }));
art("cooked_chicken", "drumstick", paletteOf("#c88a4a", { e: hex("#e8d8c0"), w: hex("#f5f0e0") }));
art("rotten_flesh", "flesh", paletteOf("#8a6a3a", { d: hex("#5a7a3a") }));
art("bread", "bread", paletteOf("#b8843a"));
art("carrot", "carrot", paletteOf("#ef8a1c", { g: hex("#4c9a2a") }));
art("potato", "potato", paletteOf("#c8a254"));
art("baked_potato", "potato", paletteOf("#d4a040", { c: hex("#f0d070") }));
art("wheat_seeds", "seeds", { b: hex("#6aa832") });
art("wheat", "wheat", { b: hex("#c9a92c"), c: hex("#e8cc54"), g: hex("#8a7a2a") });
art("feather", "feather", paletteOf("#f0f0f0", { h: hex("#999") }));
art("string", "string", { b: hex("#f0f0f0") });
art("bone", "bone", paletteOf("#e8e4d0"));
art("leather", "leather", paletteOf("#8f5a33"));
art("flint", "flint", paletteOf("#3a3a3a", { c: hex("#6a6a6a") }));
art("paper", "paper", { a: hex("#b8b8a8"), b: hex("#f2f0e6"), d: hex("#c8c6ba") });
art("book", "book", paletteOf("#7a3b22", { w: hex("#f2f0e6"), c: hex("#a55a35") }));
art("snowball", "ball", paletteOf("#f2fbfb"));
art("clay_ball", "ball", paletteOf("#a1a7b4"));
art("egg", "egg", paletteOf("#e8d6b4"));
art("spider_eye", "eye", paletteOf("#8a2a3a", { w: hex("#e04a5a") }));
art("melon_slice", "melon_slice", { a: hex("#3f6b17"), b: hex("#e0402f"), w: hex("#1a1a1a"), g: hex("#6a9f2c") });
art("pumpkin_pie", "pie", paletteOf("#d88a3a"));
art("bowl", "bowl", paletteOf("#8a6a3a", { f: hex("#3d2a14") }));
art("mushroom_stew", "stew", paletteOf("#8a6a3a", { s: hex("#b88a5a"), m: hex("#d8261c") }));
art("bow", "bow", { a: HD, b: H, h: HL, s: hex("#e8e8e8") });
art("arrow", "arrow", { a: shade(hex("#8a8a8a"), 0.5), b: hex("#9a9a9a"), h: H, w: hex("#f0f0f0") });
art("flint_and_steel", "flint_and_steel", { a: hex("#3a3a3a"), b: hex("#c8c8c8"), f: hex("#3a3a3a"), d: hex("#5a5a5a") });
art("shears", "shears", { a: hex("#5a5a5a"), b: hex("#dcdcdc"), r: hex("#8a3a2a") });
art("oak_door", "door", paletteOf("#9c7a45", { w: hex("#dcdcdc") }));
art("red_bed", "bed", { a: hex("#5a3a1a"), b: hex("#8a6a3a"), w: hex("#eeeeee"), r: hex("#b02e26") });

function paintItem(p: Pixels, name: string): boolean {
  const a = ITEM_ART[name];
  if (!a) return false;
  p.clear();
  const rows = ITEM_TEMPLATES[a.template];
  // Templates shorter than 16 rows sit at the bottom so small items rest on the slot floor.
  template(p, rows, a.palette, Math.max(0, 15 - rows.length));
  return true;
}

// ---- public -----------------------------------------------------------------------------------

/** Paints a named texture. Returns null when no painter knows the name. */
export function paintTexture(name: string, frame = 0): Pixels | null {
  const p = new Pixels();
  if (name === "water_still") { fluidFrame(p, frame, false); return p; }
  if (name === "lava_still") { fluidFrame(p, frame, true); return p; }
  const destroy = /^destroy_stage_(\d)$/.exec(name);
  if (destroy) { destroyStage(p, Number(destroy[1])); return p; }
  const painter = PAINTERS[name];
  if (painter) {
    painter(p, new Rng(seedFromString(name)));
    return p;
  }
  if (paintItem(p, name)) return p;
  return null;
}

export function blockTextureNames(): string[] {
  return Object.keys(PAINTERS);
}
export function itemTextureNames(): string[] {
  return Object.keys(ITEM_ART);
}

/** A loud placeholder for a missing texture — magenta and black, so a gap in the art is seen, not guessed at. */
export function missingTexture(): Pixels {
  const p = new Pixels();
  for (let y = 0; y < TEX; y++) for (let x = 0; x < TEX; x++) p.set(x, y, ((x >> 3) + (y >> 3)) % 2 ? hex("#f800f8") : hex("#000000"));
  return p;
}

/** Default tint colours, used for icons and for biomes with no override. */
export const DEFAULT_TINTS: Record<string, C> = {
  grass: hex("#79c05a"),
  foliage: hex("#59ae30"),
  birch: hex("#80a755"),
  spruce: hex("#619961"),
  water: hex("#3f76e4"),
};
