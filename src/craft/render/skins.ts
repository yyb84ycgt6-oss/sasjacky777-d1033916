/**
 * Mob and player skins, painted onto 64×64 canvases in the classic box-unwrap
 * layout: each box is laid out as top and bottom over a strip of its four
 * sides. The same region maths maps the canvas back onto the model's boxes
 * (models.ts), so painting and mapping cannot disagree.
 *
 * All original art. Faces, snouts, spots and patches are drawn pixel by pixel
 * from a few colours and a seeded noise, so every copy of the game shows the
 * same pig.
 */
import { Rng } from "../engine/rng";

export type Face = "top" | "bottom" | "west" | "front" | "east" | "back";

export interface Region { x: number; y: number; w: number; h: number }

/** Where each face of a w×h×d box at (u, v) sits on the skin. */
export function boxRegions(u: number, v: number, w: number, h: number, d: number): Record<Face, Region> {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    west: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    east: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + d + w + d, y: v + d, w, h },
  };
}

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

class SkinPainter {
  readonly canvas: HTMLCanvasElement;
  private img: ImageData;
  private rng: Rng;
  constructor(seed: number) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 64; this.canvas.height = 64;
    this.img = new ImageData(64, 64);
    this.rng = new Rng(seed);
  }
  px(x: number, y: number, c: RGB, jitter = 0): void {
    if (x < 0 || y < 0 || x >= 64 || y >= 64) return;
    const f = 1 + (this.rng.next() - 0.5) * jitter;
    const i = (y * 64 + x) * 4;
    this.img.data[i] = Math.min(255, c[0] * f);
    this.img.data[i + 1] = Math.min(255, c[1] * f);
    this.img.data[i + 2] = Math.min(255, c[2] * f);
    this.img.data[i + 3] = 255;
  }
  fill(r: Region, c: RGB | ((x: number, y: number) => RGB), jitter = 0.08): void {
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) this.px(r.x + x, r.y + y, typeof c === "function" ? c(x, y) : c, jitter);
  }
  box(u: number, v: number, w: number, h: number, d: number, c: RGB | ((face: Face, x: number, y: number) => RGB), jitter = 0.08): Record<Face, Region> {
    const regions = boxRegions(u, v, w, h, d);
    for (const face of Object.keys(regions) as Face[]) {
      this.fill(regions[face], typeof c === "function" ? (x, y) => c(face, x, y) : c, jitter);
    }
    return regions;
  }
  random(): number {
    return this.rng.next();
  }
  done(): HTMLCanvasElement {
    this.canvas.getContext("2d")!.putImageData(this.img, 0, 0);
    return this.canvas;
  }
}

/** Two dark eyes with a light highlight, drawn on a face region at (ex, ey) from its top-left. */
function eyes(p: SkinPainter, face: Region, y: number, xs: number[], white: RGB | null, pupil: RGB): void {
  for (const x of xs) {
    if (white) p.px(face.x + x, face.y + y, white, 0);
    p.px(face.x + x + (white ? 1 : 0), face.y + y, pupil, 0);
  }
}

// ---- mobs -------------------------------------------------------------------------------

export const SKIN_LAYOUT = {
  humanoid: { head: [0, 0], body: [16, 16], arm: [40, 16], leg: [0, 16], thinArm: [40, 16], thinLeg: [0, 16] },
};

function humanoid(p: SkinPainter, skin: RGB, hair: RGB, shirt: RGB, pants: RGB, shoes: RGB, eye: RGB): void {
  const head = p.box(0, 0, 8, 8, 8, (face, x, y) => {
    if (face === "top") return hair;
    if (face === "bottom") return skin;
    if (y < 2 || (face === "back" && y < 7) || ((face === "west" || face === "east") && y < 4 && x > 2)) return hair;
    return skin;
  });
  eyes(p, head.front, 4, [1, 5], [240, 240, 240], eye);
  p.px(head.front.x + 3, head.front.y + 6, [skin[0] * 0.7, skin[1] * 0.6, skin[2] * 0.6], 0);
  p.px(head.front.x + 4, head.front.y + 6, [skin[0] * 0.7, skin[1] * 0.6, skin[2] * 0.6], 0);
  p.box(16, 16, 8, 12, 4, (face, _x, y) => (face === "bottom" ? pants : y > 10 ? pants : shirt));
  p.box(40, 16, 4, 12, 4, (face, _x, y) => (face === "bottom" ? skin : y < 5 ? shirt : skin));
  p.box(0, 16, 4, 12, 4, (face, _x, y) => (face === "bottom" || y > 9 ? shoes : pants));
}

const cache = new Map<string, HTMLCanvasElement>();

export function skin(kind: string, variant = 0): HTMLCanvasElement {
  const key = `${kind}:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new SkinPainter(kind.length * 977 + variant);
  switch (kind) {
    case "pig": {
      const pink = hex("#f0a8a4"), dark = hex("#d88c88");
      const head = p.box(0, 0, 8, 8, 8, (_f, x, y) => ((x * 7 + y * 3) % 11 === 0 ? dark : pink));
      eyes(p, head.front, 3, [1, 5], [245, 245, 245], [20, 20, 20]);
      const snout = p.box(32, 0, 4, 3, 1, hex("#e98f8c"));
      p.px(snout.front.x + 1, snout.front.y + 1, hex("#8a3a3a"), 0);
      p.px(snout.front.x + 2, snout.front.y + 1, hex("#8a3a3a"), 0);
      p.box(0, 16, 10, 8, 16, (_f, x, y) => ((x * 5 + y * 7) % 13 === 0 ? dark : pink));
      p.box(0, 40, 4, 6, 4, (_f, _x, y) => (y > 4 ? hex("#8a5a50") : pink));
      break;
    }
    case "cow": {
      const black = hex("#2b2522"), white = hex("#ececec");
      const patch = (x: number, y: number) => (Math.sin(x * 0.7 + y * 0.3) + Math.cos(y * 0.5 - x * 0.2) > 0.4 ? white : black);
      const head = p.box(0, 0, 8, 8, 6, (face, x, y) => (face === "front" ? (x > 1 && x < 6 && y > 1 ? white : black) : patch(x, y)));
      eyes(p, head.front, 3, [1, 5], null, [10, 10, 10]);
      p.fill({ x: head.front.x + 2, y: head.front.y + 5, w: 4, h: 3 }, hex("#c9a09a"), 0.05);
      p.px(head.front.x + 2, head.front.y + 6, hex("#5a3030"), 0);
      p.px(head.front.x + 5, head.front.y + 6, hex("#5a3030"), 0);
      p.box(28, 0, 1, 3, 1, hex("#d8d0b8"));
      p.box(0, 14, 12, 10, 18, (_f, x, y) => patch(x + 3, y + 2));
      p.box(0, 42, 4, 12, 4, (_f, x, y) => (y > 10 ? hex("#5a4a3a") : patch(x, y + 5)));
      break;
    }
    case "sheep": {
      const face = hex("#d8c6b0"), wool = hex("#f2f2f2");
      const head = p.box(0, 0, 6, 6, 8, (f) => (f === "front" ? face : wool));
      eyes(p, head.front, 2, [0, 4], [245, 245, 245], [20, 20, 20]);
      p.px(head.front.x + 2, head.front.y + 4, hex("#e8a0a0"), 0);
      p.px(head.front.x + 3, head.front.y + 4, hex("#e8a0a0"), 0);
      p.box(0, 14, 8, 6, 16, hex("#d8c6b0"));
      p.box(48, 0, 4, 12, 4, (_f, _x, y) => (y < 6 ? wool : face));
      // Wool coat: grey-white, tinted per sheep at draw time.
      p.box(0, 36, 10, 8, 18, (_f, x, y) => [228 + ((x * 13 + y * 7) % 5) * 5, 228 + ((x * 13 + y * 7) % 5) * 5, 228 + ((x * 13 + y * 7) % 5) * 5], 0.06);
      break;
    }
    case "chicken": {
      const white = hex("#f6f6f6");
      const head = p.box(0, 0, 4, 6, 3, white);
      eyes(p, head.front, 2, [0, 3], null, [20, 20, 20]);
      p.box(14, 0, 4, 2, 2, hex("#f0b020"));
      p.box(14, 4, 2, 2, 2, hex("#d82020"));
      p.box(0, 9, 6, 6, 8, white);
      p.box(24, 13, 1, 4, 6, hex("#e8e8e8"));
      p.box(26, 0, 3, 5, 3, hex("#f0a020"));
      break;
    }
    case "zombie":
      humanoid(p, hex("#5e8f3e"), hex("#3f6b28"), hex("#32a0a8"), hex("#3a3c9a"), hex("#4a4a4a"), [10, 10, 10]);
      break;
    case "skeleton": {
      const bone = hex("#c9c9c9"), dark = hex("#8a8a8a");
      const head = p.box(0, 0, 8, 8, 8, bone);
      p.fill({ x: head.front.x + 1, y: head.front.y + 3, w: 2, h: 2 }, hex("#2a2a2a"), 0);
      p.fill({ x: head.front.x + 5, y: head.front.y + 3, w: 2, h: 2 }, hex("#2a2a2a"), 0);
      p.fill({ x: head.front.x + 2, y: head.front.y + 6, w: 4, h: 1 }, dark, 0);
      p.box(16, 16, 8, 12, 4, (_f, x, y) => (y % 3 === 0 || x === 3 || x === 4 ? bone : hex("#3a3a3a")));
      p.box(40, 16, 2, 12, 2, bone);
      p.box(0, 16, 2, 12, 2, bone);
      break;
    }
    case "creeper": {
      const greens = [hex("#4e9c2d"), hex("#63bd3b"), hex("#3a7a22"), hex("#79cf55")];
      const g = () => greens[Math.floor(p.random() * greens.length)];
      const head = p.box(0, 0, 8, 8, 8, () => g(), 0);
      const face = [
        "........", "........", ".XX..XX.", ".XX..XX.", "...XX...", "..XXXX..", "..XXXX..", "..X..X..",
      ];
      face.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === "X") p.px(head.front.x + x, head.front.y + y, hex("#101010"), 0.1); }));
      p.box(16, 16, 8, 12, 4, () => g(), 0);
      p.box(0, 16, 4, 6, 4, () => g(), 0);
      break;
    }
    case "spider": {
      const body = hex("#35291f"), hair = hex("#4a3a2c");
      p.box(0, 0, 6, 6, 6, (_f, x, y) => ((x + y) % 3 === 0 ? hair : body));
      const head = p.box(32, 4, 8, 8, 8, (_f, x, y) => ((x * y) % 4 === 1 ? hair : body));
      for (const [x, y] of [[1, 3], [2, 3], [5, 3], [6, 3], [2, 2], [5, 2], [3, 4], [4, 4]]) p.px(head.front.x + x, head.front.y + y, hex("#d4201c"), 0);
      p.box(0, 12, 10, 8, 12, (_f, x, y) => ((x * 3 + y) % 5 === 0 ? hair : body));
      p.box(0, 32, 16, 2, 2, hex("#2a2018"));
      break;
    }
    case "slime": {
      // The outer gel is drawn see-through (models.ts); the core inside it carries the face.
      const gel = hex("#86cc70"), rim = hex("#6fb35c");
      p.box(0, 0, 8, 8, 8, (_f, x, y) => (x === 0 || y === 0 || x === 7 || y === 7 ? rim : gel), 0.06);
      const core = p.box(0, 16, 6, 6, 6, hex("#5c9f4a"), 0.12);
      const dark = hex("#1d3818");
      p.fill({ x: core.front.x, y: core.front.y + 1, w: 2, h: 2 }, dark, 0);
      p.fill({ x: core.front.x + 4, y: core.front.y + 1, w: 2, h: 2 }, dark, 0);
      p.px(core.front.x + 3, core.front.y + 4, dark, 0);
      break;
    }
    case "villager": {
      // Robe colours by profession, in the order of PROFESSIONS (0 is the unemployed).
      const robes = ["#6a4a30", "#8a6a3a", "#e8e0d0", "#e6e6e6", "#3a7a8a", "#5a8a3a", "#8a6a4a", "#8a8a8a", "#2a2a2a", "#6a3a8a", "#7a4a2a"];
      const trims = ["#4a3220", "#c8a040", "#b02e26", "#c83a3a", "#2a5a6a", "#3a6a2a", "#f0f0f0", "#5a5a5a", "#8a8a8a", "#e8c040", "#4a2a18"];
      const robe = hex(robes[variant % robes.length]), trim = hex(trims[variant % trims.length]);
      const skinC = hex("#b98d6a"), hair = hex("#4a3020");
      const farmer = variant === 1;
      const head = p.box(0, 0, 8, 10, 8, (face, _x, y) => {
        if (face === "top") return farmer ? hex("#e0c050") : hair;
        if (farmer && y < 2) return hex("#e0c050");
        if (face === "back" && y < 4) return hair;
        return skinC;
      });
      // A heavy brow and green eyes.
      for (let x = 1; x <= 6; x++) p.px(head.front.x + x, head.front.y + 3, hair, 0);
      p.px(head.front.x + 1, head.front.y + 4, [240, 240, 240], 0); p.px(head.front.x + 2, head.front.y + 4, [40, 140, 50], 0);
      p.px(head.front.x + 5, head.front.y + 4, [40, 140, 50], 0); p.px(head.front.x + 6, head.front.y + 4, [240, 240, 240], 0);
      p.box(24, 0, 2, 4, 2, [skinC[0] * 0.85, skinC[1] * 0.8, skinC[2] * 0.8] as RGB);
      p.box(16, 20, 8, 12, 6, robe);
      p.box(0, 22, 4, 12, 4, [robe[0] * 0.8, robe[1] * 0.8, robe[2] * 0.8] as RGB);
      p.box(44, 22, 4, 8, 4, robe);
      p.box(40, 38, 8, 4, 4, (_f, x) => (x >= 2 && x <= 5 ? skinC : robe));
      p.box(0, 38, 8, 18, 6, (_f, x, y) => (y > 14 || x === 3 || x === 4 ? trim : robe));
      break;
    }
    case "iron_golem": {
      const iron = hex("#bab2a6"), dark = hex("#8e867c"), vine = hex("#4a7a2a");
      // Rust-dark blotches a few pixels across, and here and there a strand of vine.
      const metal = (_f: Face, x: number, y: number): RGB =>
        ((x >> 1) * 7 + (y >> 1) * 3) % 13 === 0 ? dark : (x * 3 + y * 5) % 29 === 0 ? vine : iron;
      // The waist shares the body's corner of the sheet, part of which no face of the body
      // covers; left bare it samples as a black hole in the golem's middle.
      p.fill({ x: 0, y: 0, w: 64, h: 64 }, (x, y) => metal("front", x, y));
      p.box(0, 0, 18, 12, 11, metal);
      const head = p.box(0, 23, 8, 10, 8, metal);
      for (let x = 1; x <= 6; x++) p.px(head.front.x + x, head.front.y + 3, dark, 0);
      p.px(head.front.x + 2, head.front.y + 4, hex("#8a2020"), 0); p.px(head.front.x + 5, head.front.y + 4, hex("#8a2020"), 0);
      p.box(24, 23, 2, 4, 2, dark);
      p.box(32, 23, 4, 30, 6, metal);
      p.box(0, 41, 6, 16, 5, (_f, x, y) => (y > 13 ? dark : metal(_f, x, y)));
      break;
    }
    case "piglin": case "zombified_piglin": {
      const zombie = kind === "zombified_piglin";
      const flesh = hex(zombie ? "#d98f86" : "#e8a39a"), dark = hex(zombie ? "#b26c66" : "#c9837a");
      const rot = hex("#6f8f4a"), bone = hex("#e6e0cc");
      // Rotting: green patches and bare bone here and there on the zombified.
      const skinAt = (x: number, y: number): RGB =>
        zombie && (x * 7 + y * 5) % 17 === 0 ? rot : zombie && (x * 3 + y * 11) % 23 === 0 ? bone : (x * 5 + y * 3) % 13 === 0 ? dark : flesh;
      const head = p.box(0, 0, 10, 8, 8, (_f, x, y) => skinAt(x, y));
      // Eyes: a piglin's are small and dark; one of a zombified piglin's is a bare socket.
      p.px(head.front.x + 2, head.front.y + 3, hex("#f4f4f4"), 0); p.px(head.front.x + 3, head.front.y + 3, hex("#202020"), 0);
      p.px(head.front.x + 6, head.front.y + 3, zombie ? bone : hex("#202020"), 0); p.px(head.front.x + 7, head.front.y + 3, zombie ? hex("#101010") : hex("#f4f4f4"), 0);
      const snout = p.box(36, 0, 4, 3, 1, hex(zombie ? "#e8a8a0" : "#f2b8ae"));
      p.px(snout.front.x + 1, snout.front.y + 1, hex("#5a2a2a"), 0); p.px(snout.front.x + 2, snout.front.y + 1, hex("#5a2a2a"), 0);
      p.box(46, 0, 1, 5, 4, dark);
      p.box(56, 0, 1, 2, 1, hex("#f0e8d0"));
      const leather = hex("#6b4a2a"), gold = hex("#f5d84a");
      p.box(16, 16, 8, 12, 4, (face, x, y) => {
        if (zombie) return y % 3 === 1 && x > 1 && x < 6 && face === "front" ? bone : skinAt(x, y);
        if (y >= 8) return y === 8 ? (x === 3 || x === 4 ? gold : leather) : leather;
        return skinAt(x, y);
      });
      p.box(40, 16, 4, 12, 4, (_f, x, y) => (!zombie && y >= 6 && y <= 7 ? leather : skinAt(x, y)));
      p.box(0, 16, 4, 12, 4, (_f, x, y) => (zombie ? (y > 9 ? dark : skinAt(x, y)) : y > 9 ? hex("#3a2a1a") : leather));
      // The golden sword: a brown grip at the hand, a gold blade.
      p.box(56, 16, 1, 10, 1, (_f, _x, y) => (y >= 8 ? hex("#6b4a26") : y === 7 ? hex("#c8a030") : gold));
      break;
    }
    case "wither_skeleton": {
      const bone = hex("#2e2e2e"), dark = hex("#161616");
      const head = p.box(0, 0, 8, 8, 8, (_f, x, y) => ((x * 3 + y * 5) % 11 === 0 ? hex("#3a3a3a") : bone));
      p.fill({ x: head.front.x + 1, y: head.front.y + 3, w: 2, h: 2 }, hex("#050505"), 0);
      p.fill({ x: head.front.x + 5, y: head.front.y + 3, w: 2, h: 2 }, hex("#050505"), 0);
      p.fill({ x: head.front.x + 2, y: head.front.y + 6, w: 4, h: 1 }, dark, 0);
      p.box(16, 16, 8, 12, 4, (_f, x, y) => (y % 3 === 0 || x === 3 || x === 4 ? bone : hex("#0e0e0e")));
      p.box(40, 16, 2, 12, 2, bone);
      p.box(0, 16, 2, 12, 2, bone);
      break;
    }
    case "ghast": {
      // Variant 1 is the moment before it spits: eyes and mouth open, rimmed red.
      const white = hex("#f2f2f0"), shade = hex("#d8d8d4");
      const body = p.box(0, 0, 16, 16, 16, (_f, x, y) => ((x * 5 + y * 3) % 9 === 0 ? shade : white), 0.04);
      const f = body.front;
      const ink = hex("#303030"), red = hex("#b01818");
      if (variant === 1) {
        for (const ex of [3, 10]) { p.fill({ x: f.x + ex, y: f.y + 4, w: 3, h: 3 }, ink, 0); p.px(f.x + ex + 1, f.y + 7, red, 0); }
        p.fill({ x: f.x + 5, y: f.y + 9, w: 6, h: 4 }, ink, 0);
        p.fill({ x: f.x + 6, y: f.y + 10, w: 4, h: 2 }, red, 0);
      } else {
        for (const ex of [3, 10]) p.fill({ x: f.x + ex, y: f.y + 6, w: 3, h: 1 }, ink, 0);
        for (const ex of [4, 11]) p.px(f.x + ex, f.y + 7, hex("#8a8a8a"), 0);
        p.fill({ x: f.x + 6, y: f.y + 11, w: 4, h: 1 }, ink, 0);
      }
      p.box(0, 32, 2, 9, 2, (_f, _x, y) => (y > 6 ? shade : white));
      break;
    }
    case "blaze": {
      const gold = hex("#f2b030"), deep = hex("#c06a10"), bright = hex("#ffe070");
      const head = p.box(0, 0, 8, 8, 8, (_f, x, y) => ((x + y) % 4 === 0 ? deep : (x * 3 + y) % 5 === 0 ? bright : gold));
      p.fill({ x: head.front.x + 1, y: head.front.y + 3, w: 2, h: 1 }, hex("#2a1a00"), 0);
      p.fill({ x: head.front.x + 5, y: head.front.y + 3, w: 2, h: 1 }, hex("#2a1a00"), 0);
      p.fill({ x: head.front.x + 2, y: head.front.y + 6, w: 4, h: 1 }, hex("#6a3a00"), 0);
      p.box(0, 16, 2, 8, 2, (_f, _x, y) => (y % 3 === 0 ? deep : bright));
      break;
    }
    case "magma_cube": {
      // A dark crust split by glowing seams, and two burning eyes.
      const crust = hex("#3a1206"), glow = hex("#ff8a1a"), hot = hex("#ffd35a");
      const shell = p.box(0, 0, 8, 8, 8, (_f, x, y) => (y === 2 || y === 5 ? (x % 3 === 0 ? hot : glow) : (x * 5 + y * 3) % 7 === 0 ? hex("#5a2008") : crust), 0.08);
      p.fill({ x: shell.front.x + 1, y: shell.front.y + 3, w: 2, h: 1 }, hot, 0);
      p.fill({ x: shell.front.x + 5, y: shell.front.y + 3, w: 2, h: 1 }, hot, 0);
      p.px(shell.front.x + 2, shell.front.y + 3, hex("#c01010"), 0); p.px(shell.front.x + 5, shell.front.y + 3, hex("#c01010"), 0);
      break;
    }
    case "hoglin": {
      // Drawn at half size (the model doubles it).
      const hide = hex("#c27a5c"), dark = hex("#8e4c38"), bristle = hex("#dcc27a");
      p.box(0, 0, 8, 7, 13, (_f, x, y) => ((x * 3 + y * 5) % 7 === 0 ? dark : hide));
      p.box(44, 0, 1, 4, 9, (_f, x, y) => ((x + y) % 2 ? bristle : hex("#b89a58")));
      const head = p.box(0, 20, 7, 5, 8, (face, x, y) => (face === "front" && y >= 3 ? hex("#d89a82") : (x + y) % 5 === 0 ? dark : hide));
      p.px(head.front.x + 1, head.front.y + 1, hex("#1a1a1a"), 0); p.px(head.front.x + 5, head.front.y + 1, hex("#1a1a1a"), 0);
      p.px(head.front.x + 2, head.front.y + 4, hex("#5a2a20"), 0); p.px(head.front.x + 4, head.front.y + 4, hex("#5a2a20"), 0);
      p.box(30, 20, 1, 3, 1, hex("#f2ead6"));
      p.box(34, 20, 3, 1, 2, dark);
      p.box(0, 34, 3, 5, 3, (_f, _x, y) => (y >= 4 ? hex("#3a2a20") : hide));
      break;
    }
    case "boat": {
      // Drawn at half size (the model doubles it): planks with dark seams, per wood.
      const woods = ["#9c7a45", "#6b5030", "#c8b77a", "#a0724a", "#b0603a"];
      const plank = hex(woods[variant % woods.length]);
      const seam = [plank[0] * 0.7, plank[1] * 0.7, plank[2] * 0.7] as RGB;
      const wood = (_f: Face, _x: number, y: number): RGB => (y % 3 === 2 ? seam : plank);
      p.box(0, 0, 10, 1, 14, wood);
      p.box(0, 16, 1, 3, 14, wood);
      p.box(32, 16, 9, 3, 1, wood);
      p.box(0, 36, 1, 1, 7, hex("#6b4a26"));
      break;
    }
    case "minecart": {
      const iron = hex("#8a8a8e"), dark = hex("#4a4a4e");
      const rim = (_f: Face, x: number, y: number): RGB => (y === 0 || x === 0 ? dark : iron);
      p.box(0, 0, 8, 1, 10, (_f, x, y) => ((x + y) % 4 === 0 ? dark : iron));
      p.box(0, 12, 1, 4, 10, rim);
      p.box(24, 12, 6, 4, 1, rim);
      break;
    }
    case "player": {
      const hues = [
        ["#3aa8a8", "#2e3a8c"], ["#a83a3a", "#3a3a3a"], ["#3a8a3a", "#5a4a2a"], ["#8a3aa8", "#2a2a5a"],
        ["#c8a030", "#3a3a8a"], ["#e06a2a", "#2a4a2a"], ["#2a6ad8", "#4a4a4a"], ["#d84a8a", "#3a2a4a"],
      ];
      const [shirt, pants] = hues[variant % hues.length];
      const skins = ["#c89a78", "#a8744e", "#e8c09a", "#7a5236"];
      const hairs = ["#3a2412", "#1a1a1a", "#a8742a", "#5a3a1a"];
      humanoid(p, hex(skins[(variant >> 3) % skins.length]), hex(hairs[(variant >> 2) % hairs.length]), hex(shirt), hex(pants), hex("#3a3a3a"), [40, 60, 160]);
      break;
    }
  }
  const canvas = p.done();
  cache.set(key, canvas);
  return canvas;
}
