/**
 * Box models for mobs and players, and the views that pose them each frame.
 *
 * A model is a tree of pivots with boxes hung off them; legs swing about the
 * hip, arms about the shoulder, the head about the neck. Everything is in
 * sixteenths of a block — the unit the skins are painted in — and scaled once
 * at the root.
 */
import * as THREE from "three";
import { WOOL_COLORS } from "../engine/blocks";
import { boxRegions, skin, type Face } from "./skins";
import { col, createLitBlockMaterial, createSpriteMaterial, type SharedUniforms } from "./materials";
import { itemModel } from "./itemModels";

const FACE_ORDER: Face[] = ["east", "west", "top", "bottom", "back", "front"];

function boxGeometry(w: number, h: number, d: number, u: number, v: number, inflate = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry((w + inflate * 2) / 16, (h + inflate * 2) / 16, (d + inflate * 2) / 16);
  const regions = boxRegions(u, v, w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  FACE_ORDER.forEach((face, f) => {
    const r = regions[face];
    const x0 = r.x / 64, x1 = (r.x + r.w) / 64, y0 = 1 - r.y / 64, y1 = 1 - (r.y + r.h) / 64;
    // BoxGeometry vertex order per face: top-left, top-right, bottom-left, bottom-right.
    uv.setXY(f * 4, x0, y0);
    uv.setXY(f * 4 + 1, x1, y0);
    uv.setXY(f * 4 + 2, x0, y1);
    uv.setXY(f * 4 + 3, x1, y1);
  });
  uv.needsUpdate = true;
  return g;
}

interface PartSpec {
  name: string;
  size: [number, number, number];
  uv: [number, number];
  pivot: [number, number, number];
  offset?: [number, number, number];
  rotation?: [number, number, number];
  inflate?: number;
  material?: "main" | "wool" | "gel";
  children?: PartSpec[];
}

const HUMANOID = (thin: boolean): PartSpec[] => {
  const limb = thin ? 2 : 4;
  const armX = thin ? 5 : 6;
  return [
    { name: "body", size: [8, 12, 4], uv: [16, 16], pivot: [0, 18, 0] },
    { name: "head", size: [8, 8, 8], uv: [0, 0], pivot: [0, 24, 0], offset: [0, 4, 0] },
    { name: "rightArm", size: [limb, 12, limb], uv: [40, 16], pivot: [-armX, 22, 0], offset: [0, -4, 0] },
    { name: "leftArm", size: [limb, 12, limb], uv: [40, 16], pivot: [armX, 22, 0], offset: [0, -4, 0] },
    { name: "rightLeg", size: [limb, 12, limb], uv: [0, 16], pivot: [-2, 12, 0], offset: [0, -6, 0] },
    { name: "leftLeg", size: [limb, 12, limb], uv: [0, 16], pivot: [2, 12, 0], offset: [0, -6, 0] },
  ];
};

const legs4 = (size: [number, number, number], uv: [number, number], x: number, y: number, z: number): PartSpec[] => [
  { name: "legFR", size, uv, pivot: [-x, y, -z], offset: [0, -size[1] / 2, 0] },
  { name: "legFL", size, uv, pivot: [x, y, -z], offset: [0, -size[1] / 2, 0] },
  { name: "legBR", size, uv, pivot: [-x, y, z], offset: [0, -size[1] / 2, 0] },
  { name: "legBL", size, uv, pivot: [x, y, z], offset: [0, -size[1] / 2, 0] },
];

const MODELS: Record<string, PartSpec[]> = {
  // Vehicles are modelled at half size and drawn at `size: 2`, so their skins fit the 64×64 sheet.
  boat: [
    { name: "bottom", size: [10, 1, 14], uv: [0, 0], pivot: [0, 0.5, 0] },
    { name: "left", size: [1, 3, 14], uv: [0, 16], pivot: [-5.5, 2, 0] },
    { name: "right", size: [1, 3, 14], uv: [0, 16], pivot: [5.5, 2, 0] },
    { name: "front", size: [9, 3, 1], uv: [32, 16], pivot: [0, 2, -7.5] },
    { name: "back", size: [9, 3, 1], uv: [32, 16], pivot: [0, 2, 7.5] },
    { name: "paddleL", size: [1, 1, 7], uv: [0, 36], pivot: [-6, 3.5, -1], offset: [0, 0, 2.5] },
    { name: "paddleR", size: [1, 1, 7], uv: [0, 36], pivot: [6, 3.5, -1], offset: [0, 0, 2.5] },
  ],
  minecart: [
    { name: "bottom", size: [8, 1, 10], uv: [0, 0], pivot: [0, 1.5, 0] },
    { name: "left", size: [1, 4, 10], uv: [0, 12], pivot: [-4.5, 3, 0] },
    { name: "right", size: [1, 4, 10], uv: [0, 12], pivot: [4.5, 3, 0] },
    { name: "front", size: [6, 4, 1], uv: [24, 12], pivot: [0, 3, -4.5] },
    { name: "back", size: [6, 4, 1], uv: [24, 12], pivot: [0, 3, 4.5] },
  ],
  // A cube of jelly with a darker core; scaled by the slime's size in pose().
  slime: [
    { name: "core", size: [6, 6, 6], uv: [0, 16], pivot: [0, 4, 0] },
    { name: "gel", size: [8, 8, 8], uv: [0, 0], pivot: [0, 4, 0], material: "gel" },
  ],
  player: HUMANOID(false),
  zombie: HUMANOID(false),
  skeleton: HUMANOID(true),
  pig: [
    { name: "body", size: [10, 8, 16], uv: [0, 16], pivot: [0, 10, 0] },
    { name: "head", size: [8, 8, 8], uv: [0, 0], pivot: [0, 12, -7], offset: [0, 0, -4],
      children: [{ name: "snout", size: [4, 3, 1], uv: [32, 0], pivot: [0, -1, -4.5] }] },
    ...legs4([4, 6, 4], [0, 40], 3, 6, 5),
  ],
  cow: [
    { name: "body", size: [12, 10, 18], uv: [0, 14], pivot: [0, 17, 0] },
    { name: "head", size: [8, 8, 6], uv: [0, 0], pivot: [0, 20, -9], offset: [0, 0, -3],
      children: [
        { name: "hornR", size: [1, 3, 1], uv: [28, 0], pivot: [-4.5, 4.5, -1] },
        { name: "hornL", size: [1, 3, 1], uv: [28, 0], pivot: [4.5, 4.5, -1] },
      ] },
    ...legs4([4, 12, 4], [0, 42], 4, 12, 7),
  ],
  sheep: [
    { name: "body", size: [8, 6, 16], uv: [0, 14], pivot: [0, 15, 0] },
    { name: "wool", size: [10, 8, 18], uv: [0, 36], pivot: [0, 15, 0], material: "wool" },
    { name: "head", size: [6, 6, 8], uv: [0, 0], pivot: [0, 18, -8], offset: [0, 0, -3] },
    ...legs4([4, 12, 4], [48, 0], 3, 12, 5),
  ],
  chicken: [
    { name: "body", size: [6, 6, 8], uv: [0, 9], pivot: [0, 8, 0] },
    { name: "head", size: [4, 6, 3], uv: [0, 0], pivot: [0, 9, -4], offset: [0, 3, -1],
      children: [
        { name: "beak", size: [4, 2, 2], uv: [14, 0], pivot: [0, 1, -2.5] },
        { name: "wattle", size: [2, 2, 2], uv: [14, 4], pivot: [0, -1, -2] },
      ] },
    { name: "wingR", size: [1, 4, 6], uv: [24, 13], pivot: [-3.5, 10, 0], offset: [0, -2, 0] },
    { name: "wingL", size: [1, 4, 6], uv: [24, 13], pivot: [3.5, 10, 0], offset: [0, -2, 0] },
    { name: "legR", size: [3, 5, 3], uv: [26, 0], pivot: [-1.5, 5, 1], offset: [0, -2.5, 0] },
    { name: "legL", size: [3, 5, 3], uv: [26, 0], pivot: [1.5, 5, 1], offset: [0, -2.5, 0] },
  ],
  creeper: [
    { name: "body", size: [8, 12, 4], uv: [16, 16], pivot: [0, 12, 0] },
    { name: "head", size: [8, 8, 8], uv: [0, 0], pivot: [0, 18, 0], offset: [0, 4, 0] },
    ...legs4([4, 6, 4], [0, 16], 2, 6, 4),
  ],
  spider: [
    { name: "thorax", size: [6, 6, 6], uv: [0, 0], pivot: [0, 9, 0] },
    { name: "abdomen", size: [10, 8, 12], uv: [0, 12], pivot: [0, 10, 9] },
    { name: "head", size: [8, 8, 8], uv: [32, 4], pivot: [0, 9, -3], offset: [0, 0, -4] },
    ...[-1, 1].flatMap((side) =>
      [-1.5, -0.5, 0.5, 1.5].map((z, i): PartSpec => ({
        name: `leg${side}${i}`, size: [16, 2, 2], uv: [0, 32], pivot: [side * 3, 9, z * 2],
        offset: [side * 8, 0, 0], rotation: [0, side * (z * 0.35), side * -0.6],
      })),
    ),
  ],
};

export interface ModelInstance {
  root: THREE.Group;
  parts: Map<string, THREE.Object3D>;
  material: THREE.MeshBasicMaterial;
  wool?: THREE.MeshBasicMaterial;
  gel?: THREE.MeshBasicMaterial;
}

const textures = new Map<string, THREE.CanvasTexture>();
function skinTexture(kind: string, variant: number): THREE.CanvasTexture {
  const key = `${kind}:${variant}`;
  let t = textures.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(skin(kind, variant));
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    textures.set(key, t);
  }
  return t;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();

export function buildModel(kind: string, variant = 0): ModelInstance {
  const material = new THREE.MeshBasicMaterial({ map: skinTexture(kind, variant) });
  const wool = kind === "sheep" ? new THREE.MeshBasicMaterial({ map: skinTexture(kind, variant) }) : undefined;
  // Depth writes off so the core shows through the jelly from every side.
  const gel = kind === "slime"
    ? new THREE.MeshBasicMaterial({ map: skinTexture(kind, variant), transparent: true, opacity: 0.6, depthWrite: false })
    : undefined;
  const root = new THREE.Group();
  const scaleGroup = new THREE.Group();
  scaleGroup.scale.setScalar(1);
  root.add(scaleGroup);
  const parts = new Map<string, THREE.Object3D>();
  const build = (spec: PartSpec, parent: THREE.Object3D) => {
    const pivot = new THREE.Group();
    pivot.position.set(spec.pivot[0] / 16, spec.pivot[1] / 16, spec.pivot[2] / 16);
    if (spec.rotation) pivot.rotation.set(...spec.rotation);
    const gkey = `${spec.size}:${spec.uv}:${spec.inflate ?? 0}`;
    let g = geometryCache.get(gkey);
    if (!g) { g = boxGeometry(spec.size[0], spec.size[1], spec.size[2], spec.uv[0], spec.uv[1], spec.inflate); geometryCache.set(gkey, g); }
    const mesh = new THREE.Mesh(g, spec.material === "wool" && wool ? wool : spec.material === "gel" && gel ? gel : material);
    if (spec.offset) mesh.position.set(spec.offset[0] / 16, spec.offset[1] / 16, spec.offset[2] / 16);
    pivot.add(mesh);
    parent.add(pivot);
    parts.set(spec.name, pivot);
    for (const c of spec.children ?? []) build(c, mesh);
  };
  for (const spec of MODELS[kind] ?? MODELS.pig) build(spec, scaleGroup);
  parts.set("__scale", scaleGroup);
  return { root, parts, material, wool, gel };
}

export interface PoseInput {
  x: number; y: number; z: number;
  yaw: number;
  pitch: number;
  /** Distance walked (interpolated) and recent speed, for the leg swing. */
  walk: number;
  speed: number;
  /** 0..1 light from world brightness. */
  light: number;
  hurt: boolean;
  /** Ticks into dying, or 0. */
  death: number;
  swing: number;
  time: number;
  baby?: boolean;
  sneaking?: boolean;
  /** Creeper swell 0..1. */
  swell?: number;
  flash?: boolean;
  woolColor?: number;
  sheared?: boolean;
  onGround?: boolean;
  armsForward?: boolean;
  /** A slime's size (1, 2 or 4) and its stretch or squash. */
  size?: number;
  squish?: number;
  /** Sideways tilt: a vehicle's shake when struck. */
  rock?: number;
  /** A rider: legs forward, as seated in a boat or a cart. */
  sitting?: boolean;
}

const WOOL_TINTS = WOOL_COLORS.map((c) => ({
  white: "#f0f0f0", orange: "#f9801d", magenta: "#c74ebd", light_blue: "#3ab3da", yellow: "#fed83d", lime: "#80c71f",
  pink: "#f38baa", gray: "#474f52", light_gray: "#9d9d97", cyan: "#169c9c", purple: "#8932b8", blue: "#3c44aa",
  brown: "#835432", green: "#5e7c16", red: "#b02e26", black: "#1d1d21",
}[c]!));

export function pose(m: ModelInstance, kind: string, p: PoseInput): void {
  const r = m.root;
  r.position.set(p.x, p.y, p.z);
  r.rotation.set(0, p.yaw, 0);
  const scale = m.parts.get("__scale")!;
  const s = (p.baby ? 0.5 : 1) * (1 + (p.swell ?? 0) * 0.25) * (p.size ?? 1);
  const stretch = 1 + (p.squish ?? 0) * 0.5;
  scale.scale.set(s * (1 + (p.swell ?? 0) * 0.1) / stretch, s * stretch, s * (1 + (p.swell ?? 0) * 0.1) / stretch);
  if (p.death > 0) r.rotation.z = Math.min(1, p.death / 20) * (Math.PI / 2);
  else r.rotation.z = p.rock ?? 0;

  const l = Math.max(0.12, p.light);
  const hurtTint = p.hurt || p.death > 0;
  m.material.color.setRGB(l, hurtTint ? l * 0.45 : l, hurtTint ? l * 0.45 : l);
  if (p.flash) m.material.color.setRGB(1.6, 1.6, 1.6);
  if (m.gel) m.gel.color.copy(m.material.color);
  if (m.wool) {
    const c = col(WOOL_TINTS[p.woolColor ?? 0] ?? "#f0f0f0");
    m.wool.color.setRGB(c.r * l, c.g * l * (hurtTint ? 0.45 : 1), c.b * l * (hurtTint ? 0.45 : 1));
    const wool = m.parts.get("wool");
    if (wool) wool.visible = !p.sheared;
  }

  const swing = Math.sin(p.walk * 4) * Math.min(1, p.speed * 8) * 1.1;
  const set = (name: string, x: number, y = 0, z = 0) => {
    const part = m.parts.get(name);
    if (part) part.rotation.set(x, y, z);
  };
  const head = m.parts.get("head");
  // Pitch is positive looking up; a positive x rotation tips the -z face upward.
  if (head) head.rotation.set(p.pitch, 0, 0);

  switch (kind) {
    case "player": case "zombie": case "skeleton": {
      const sneak = p.sneaking ? 0.5 : 0;
      const body = m.parts.get("body");
      if (body) body.rotation.x = sneak;
      if (p.armsForward) {
        set("rightArm", -Math.PI / 2 + Math.sin(p.time * 3) * 0.05, 0, 0);
        set("leftArm", -Math.PI / 2 - Math.sin(p.time * 3) * 0.05, 0, 0);
      } else {
        const attack = p.swing > 0 ? -Math.sin(p.swing * Math.PI) * 1.4 : 0;
        set("rightArm", -swing + attack - sneak * 0.4, 0, 0.05);
        set("leftArm", swing - sneak * 0.4, 0, -0.05);
      }
      if (p.sitting) { set("rightLeg", -1.4, 0.1); set("leftLeg", -1.4, -0.1); }
      else { set("rightLeg", swing); set("leftLeg", -swing); }
      break;
    }
    case "boat": {
      // The paddles dip in turn while the boat is driven.
      // Angled out over the sides, blades dipping behind as they pull.
      const stroke = p.walk;
      set("paddleL", 0.4 + Math.sin(stroke) * 0.4, -0.7 + Math.cos(stroke) * 0.25, 0);
      set("paddleR", 0.4 + Math.sin(stroke) * 0.4, 0.7 - Math.cos(stroke) * 0.25, 0);
      break;
    }
    case "pig": case "cow": case "sheep": case "creeper":
      set("legFR", swing); set("legBL", swing);
      set("legFL", -swing); set("legBR", -swing);
      break;
    case "chicken": {
      set("legR", swing); set("legL", -swing);
      const flap = p.onGround ? 0 : Math.sin(p.time * 30) * 0.8 + 0.8;
      set("wingR", 0, 0, flap); set("wingL", 0, 0, -flap);
      break;
    }
    case "spider": {
      for (const [name, part] of m.parts) {
        if (!name.startsWith("leg")) continue;
        const side = name.startsWith("leg-1") ? -1 : 1;
        const i = Number(name.slice(-1));
        const phase = Math.sin(p.walk * 6 + i * 1.6) * Math.min(1, p.speed * 8) * 0.4;
        const z = [-1.5, -0.5, 0.5, 1.5][i];
        part.rotation.set(0, side * (z * 0.35) + phase, side * -0.6 + Math.abs(phase) * 0.3 * side);
      }
      break;
    }
  }
}

// ---- items in the world ---------------------------------------------------------------

export class ItemView {
  readonly root = new THREE.Group();
  private mesh: THREE.Mesh;
  private material: THREE.RawShaderMaterial;
  readonly kind: "block" | "sprite";

  constructor(shared: SharedUniforms, itemId: number, private count: number, size = 1) {
    const model = itemModel(itemId);
    this.kind = model.kind;
    this.material = model.kind === "block" ? createLitBlockMaterial(shared) : createSpriteMaterial(shared);
    this.mesh = new THREE.Mesh(model.geometry, this.material);
    const s = (model.kind === "block" ? 0.25 : 0.4) * size;
    this.mesh.scale.setScalar(s);
    this.root.add(this.mesh);
    // A stack shows as two or three copies, like a little pile.
    const extra = count > 32 ? 2 : count > 1 ? 1 : 0;
    for (let i = 0; i < extra; i++) {
      const c = new THREE.Mesh(model.geometry, this.material);
      c.scale.setScalar(s);
      c.position.set((i + 1) * 0.05, (i + 1) * 0.03, (i + 1) * -0.05);
      this.root.add(c);
    }
  }

  setLight(sky: number, blockLight: number): void {
    this.material.uniforms.uSky.value = sky;
    this.material.uniforms.uBlock.value = blockLight;
  }

  setFlash(v: number): void {
    this.material.uniforms.uFlash.value = v;
  }

  dispose(): void {
    this.material.dispose();
  }

  get stackCount(): number {
    return this.count;
  }
}

/** A name floating above another player. */
export function nameTag(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = "bold 28px monospace";
  const w = Math.ceil(ctx.measureText(text).width) + 16;
  c.width = w; c.height = 40;
  ctx.font = "bold 28px monospace";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(0, 0, w, 40);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, 21);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(w / 80, 0.5, 1);
  sprite.renderOrder = 10;
  return sprite;
}
