/**
 * Particles: block debris when mining, smoke, hearts, splashes, explosions.
 *
 * One Points object with a fixed pool, simulated on the CPU and drawn from the
 * texture atlas. Block debris samples a random 4×4 corner of the block's own
 * texture, so breaking grass throws green-and-brown chips and breaking stone
 * throws grey ones without any per-block particle art.
 */
import * as THREE from "three";
import { block, faceTexture } from "../engine/blocks";
import { layerOf } from "../engine/atlas";
import type { World } from "../engine/world";
import type { SharedUniforms } from "./materials";

const MAX = 3000;

interface Kind {
  layer: string;
  gravity: number;
  life: [number, number];
  size: [number, number];
  drag: number;
  collide: boolean;
  grow?: number;
  fullTexture?: boolean;
  /** Coloured by the emit call's data (0xRRGGBB), or this default. */
  tint?: number;
  /** Starting speed; drifting kinds barely move. */
  speed?: number;
}

const KINDS: Record<string, Kind> = {
  smoke: { layer: "particle_smoke", gravity: -0.3, life: [0.6, 1.4], size: [0.15, 0.3], drag: 0.96, collide: false, grow: 1.5, fullTexture: true },
  poof: { layer: "particle_smoke", gravity: -0.5, life: [0.4, 0.9], size: [0.2, 0.35], drag: 0.9, collide: false, fullTexture: true },
  explosion: { layer: "particle_smoke", gravity: -0.4, life: [0.6, 1.4], size: [0.6, 1.4], drag: 0.92, collide: false, grow: 1.2, fullTexture: true },
  heart: { layer: "particle_heart", gravity: -0.6, life: [0.8, 1.2], size: [0.2, 0.25], drag: 0.95, collide: false, fullTexture: true },
  flame: { layer: "particle_flame", gravity: -0.2, life: [0.3, 0.6], size: [0.08, 0.12], drag: 0.95, collide: false, fullTexture: true },
  crit: { layer: "particle_spark", gravity: 2, life: [0.3, 0.6], size: [0.08, 0.14], drag: 0.9, collide: false, fullTexture: true },
  bubble: { layer: "particle_bubble", gravity: -3, life: [0.4, 1.0], size: [0.06, 0.1], drag: 0.85, collide: false, fullTexture: true },
  splash: { layer: "water_still", gravity: 9, life: [0.3, 0.7], size: [0.06, 0.1], drag: 0.98, collide: true },
  snow: { layer: "snow", gravity: 6, life: [0.4, 0.8], size: [0.06, 0.1], drag: 0.98, collide: true },
  egg: { layer: "egg", gravity: 9, life: [0.3, 0.7], size: [0.06, 0.1], drag: 0.98, collide: true },
  slime: { layer: "slime_ball", gravity: 9, life: [0.3, 0.7], size: [0.06, 0.12], drag: 0.98, collide: true },
  // A burst of potion mist; tinted per potion through the particle's data colour.
  potion: { layer: "particle_smoke", gravity: -0.6, life: [0.5, 1.2], size: [0.06, 0.12], drag: 0.88, collide: false, fullTexture: true },
  note: { layer: "particle_note", gravity: -0.5, life: [0.8, 1.0], size: [0.2, 0.2], drag: 0.9, collide: false, fullTexture: true },
  block: { layer: "stone", gravity: 14, life: [0.4, 1.2], size: [0.07, 0.12], drag: 0.98, collide: true },
  // The Nether: sparks off a portal, and what drifts in each biome's air.
  portal: { layer: "particle_spark", gravity: -0.4, life: [0.8, 1.6], size: [0.06, 0.1], drag: 0.9, collide: false, fullTexture: true, tint: 0xb070ff, speed: 1.2 },
  ash: { layer: "particle_smoke", gravity: 0.25, life: [3, 5], size: [0.04, 0.07], drag: 0.99, collide: true, fullTexture: true, tint: 0x8a8580, speed: 0.15 },
  crimson_spores: { layer: "particle_spark", gravity: 0.08, life: [3, 6], size: [0.04, 0.06], drag: 0.99, collide: false, fullTexture: true, tint: 0xd03a2a, speed: 0.15 },
  warped_spores: { layer: "particle_spark", gravity: -0.08, life: [3, 6], size: [0.04, 0.06], drag: 0.99, collide: false, fullTexture: true, tint: 0x3ce6b8, speed: 0.15 },
  soul: { layer: "particle_spark", gravity: -0.35, life: [1, 2], size: [0.08, 0.12], drag: 0.96, collide: false, fullTexture: true, tint: 0x6ae8ff, speed: 0.3 },
  lava_spark: { layer: "particle_flame", gravity: 6, life: [0.5, 1.2], size: [0.06, 0.1], drag: 0.99, collide: true, fullTexture: true, speed: 2 },
};

export class Particles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX * 3);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private gravity = new Float32Array(MAX);
  private drag = new Float32Array(MAX);
  private grow = new Float32Array(MAX);
  private baseSize = new Float32Array(MAX);
  private collide = new Uint8Array(MAX);
  private attrPos: THREE.BufferAttribute;
  private attrData: THREE.BufferAttribute;
  private attrTex: THREE.BufferAttribute;
  private data = new Float32Array(MAX * 4); // size, alpha, light, unused
  private tex = new Float32Array(MAX * 4); // layer, u offset, v offset, span
  private color = new Float32Array(MAX * 3).fill(1);
  private attrColor: THREE.BufferAttribute;
  private next = 0;
  budget = 1;

  constructor(shared: SharedUniforms, public world: World) {
    const g = new THREE.BufferGeometry();
    this.attrPos = new THREE.BufferAttribute(this.pos, 3);
    this.attrData = new THREE.BufferAttribute(this.data, 4);
    this.attrTex = new THREE.BufferAttribute(this.tex, 4);
    this.attrColor = new THREE.BufferAttribute(this.color, 3);
    this.attrColor.setUsage(THREE.DynamicDrawUsage);
    this.attrPos.setUsage(THREE.DynamicDrawUsage);
    this.attrData.setUsage(THREE.DynamicDrawUsage);
    this.attrTex.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.attrPos);
    g.setAttribute("aData", this.attrData);
    g.setAttribute("aTex", this.attrTex);
    g.setAttribute("aColor", this.attrColor);
    const m = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: `
        precision highp float;
        uniform mat4 modelViewMatrix;
        uniform mat4 projectionMatrix;
        uniform float uScale;
        in vec3 position;
        in vec4 aData;
        in vec4 aTex;
        in vec3 aColor;
        out vec4 vTex;
        out float vAlpha;
        out float vLight;
        out vec3 vColor;
        void main() {
          vTex = aTex;
          vColor = aColor;
          vAlpha = aData.y;
          vLight = aData.z;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aData.y > 0.0 ? aData.x * uScale / max(0.1, -mv.z) : 0.0;
        }`,
      fragmentShader: `
        precision highp float;
        precision highp sampler2DArray;
        uniform sampler2DArray uAtlas;
        in vec4 vTex;
        in float vAlpha;
        in float vLight;
        in vec3 vColor;
        out vec4 outColor;
        void main() {
          vec2 uv = vTex.yz + vec2(gl_PointCoord.x, gl_PointCoord.y) * vTex.w;
          vec4 t = texture(uAtlas, vec3(uv, vTex.x));
          if (t.a * vAlpha < 0.1) discard;
          outColor = vec4(t.rgb * vColor * vLight, t.a * vAlpha);
        }`,
      uniforms: { uAtlas: shared.uAtlas, uScale: { value: 800 } },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  setViewportHeight(h: number, fov: number): void {
    (this.points.material as THREE.RawShaderMaterial).uniforms.uScale.value = h / (2 * Math.tan((fov * Math.PI) / 360));
  }

  /** `blockId` is the block for "block" particles and an 0xRRGGBB tint for "potion" ones. */
  emit(kind: string, x: number, y: number, z: number, count = 1, blockId = 0, spread = 0.3): void {
    const k = KINDS[kind] ?? KINDS.smoke;
    const n = Math.max(1, Math.round(count * this.budget));
    let layer = layerOf(k.layer);
    if (kind === "block" && blockId > 0) layer = layerOf(faceTexture(block(blockId), 0, 4));
    for (let i = 0; i < n; i++) {
      const p = this.next;
      this.next = (this.next + 1) % MAX;
      this.pos[p * 3] = x + (Math.random() - 0.5) * spread * 2;
      this.pos[p * 3 + 1] = y + (Math.random() - 0.5) * spread * 2;
      this.pos[p * 3 + 2] = z + (Math.random() - 0.5) * spread * 2;
      const speed = k.speed ?? (kind === "explosion" ? 4 : kind === "block" || kind === "splash" || kind === "crit" || kind === "potion" ? 3 : 0.6);
      this.vel[p * 3] = (Math.random() - 0.5) * speed;
      this.vel[p * 3 + 1] = (Math.random() * 0.8 + (kind === "block" || kind === "splash" ? 0.6 : 0.1)) * speed;
      this.vel[p * 3 + 2] = (Math.random() - 0.5) * speed;
      const life = k.life[0] + Math.random() * (k.life[1] - k.life[0]);
      this.life[p] = life;
      this.maxLife[p] = life;
      this.gravity[p] = k.gravity;
      this.drag[p] = k.drag;
      this.grow[p] = k.grow ?? 1;
      this.collide[p] = k.collide ? 1 : 0;
      this.baseSize[p] = k.size[0] + Math.random() * (k.size[1] - k.size[0]);
      const span = k.fullTexture ? 1 : 0.25;
      this.tex[p * 4] = layer;
      this.tex[p * 4 + 1] = k.fullTexture ? 0 : Math.floor(Math.random() * 4) * 0.25;
      this.tex[p * 4 + 2] = k.fullTexture ? 0 : Math.floor(Math.random() * 4) * 0.25;
      this.tex[p * 4 + 3] = span;
      this.data[p * 4] = this.baseSize[p];
      this.data[p * 4 + 1] = 1;
      this.data[p * 4 + 2] = 1;
      const tint = kind === "potion" ? blockId : k.tint !== undefined ? (blockId || k.tint) : 0xffffff;
      this.color[p * 3] = ((tint >> 16) & 255) / 255;
      this.color[p * 3 + 1] = ((tint >> 8) & 255) / 255;
      this.color[p * 3 + 2] = (tint & 255) / 255;
    }
    this.attrColor.needsUpdate = true;
  }

  update(dt: number, daylight: number, ambient = 0): void {
    for (let p = 0; p < MAX; p++) {
      if (this.life[p] <= 0) { this.data[p * 4 + 1] = 0; continue; }
      this.life[p] -= dt;
      const i = p * 3;
      this.vel[i + 1] -= this.gravity[p] * dt;
      const d = Math.pow(this.drag[p], dt * 20);
      this.vel[i] *= d; this.vel[i + 1] *= d; this.vel[i + 2] *= d;
      let nx = this.pos[i] + this.vel[i] * dt, ny = this.pos[i + 1] + this.vel[i + 1] * dt, nz = this.pos[i + 2] + this.vel[i + 2] * dt;
      if (this.collide[p]) {
        const id = this.world.blockAt(Math.floor(nx), Math.floor(ny), Math.floor(nz));
        if (id && block(id).solid) {
          ny = this.pos[i + 1];
          this.vel[i + 1] = 0;
          this.vel[i] *= 0.5; this.vel[i + 2] *= 0.5;
          nx = this.pos[i]; nz = this.pos[i + 2];
        }
      }
      this.pos[i] = nx; this.pos[i + 1] = ny; this.pos[i + 2] = nz;
      const t = this.life[p] / this.maxLife[p];
      this.data[p * 4] = this.baseSize[p] * (1 + (1 - t) * (this.grow[p] - 1));
      this.data[p * 4 + 1] = Math.min(1, t * 3);
      if (p % 8 === (this.frame & 7)) {
        const l = this.world.getLight(Math.floor(nx), Math.floor(ny), Math.floor(nz));
        const lv = Math.max(l < 0 ? 15 * daylight : Math.max((l >> 4) * daylight, l & 15), ambient * 15);
        this.data[p * 4 + 2] = 0.15 + (lv / 15) * 0.85;
      }
    }
    this.frame++;
    this.attrPos.needsUpdate = true;
    this.attrData.needsUpdate = true;
    this.attrTex.needsUpdate = true;
  }
  private frame = 0;

  clear(): void {
    this.life.fill(0);
    this.data.fill(0);
  }
}
