/**
 * Sky, sun, moon, stars and clouds, and the colours of a day.
 *
 * Time follows the original's clock: 0 is sunrise, 6000 noon, 12000 sunset,
 * 18000 midnight, 24000 ticks to a day. The fog is the horizon colour, so
 * distant terrain dissolves into the sky rather than stopping at a wall.
 */
import * as THREE from "three";
import { DAY_TICKS } from "../engine/constants";
import { layerPixels } from "../engine/atlas";
import { Simplex } from "../engine/noise";
import { Rng } from "../engine/rng";
import { col } from "./materials";

export interface SkyState {
  /** Sun direction, unit vector. */
  sun: THREE.Vector3;
  /** 0 (night) .. 1 (full day), what sky light is multiplied by. */
  daylight: number;
  top: THREE.Color;
  horizon: THREE.Color;
  stars: number;
  sunset: number;
  cloud: THREE.Color;
}

const DAY_TOP = col("#5f9bff");
const DAY_HORIZON = col("#b9d4ff");
const NIGHT_TOP = col("#02040d");
const NIGHT_HORIZON = col("#0b1022");
const SUNSET = col("#ff8a3d");
const RAIN_TOP = col("#5b6573");
const RAIN_HORIZON = col("#8b929c");

export function skyState(time: number, rain: number, thunder: number): SkyState {
  const angle = ((time % DAY_TICKS) / DAY_TICKS) * Math.PI * 2;
  const sun = new THREE.Vector3(Math.cos(angle), Math.sin(angle), 0.12).normalize();
  const elevation = Math.sin(angle);
  let daylight = Math.max(0, Math.min(1, elevation * 2.2 + 0.45));
  daylight *= 1 - rain * 0.25 - thunder * 0.25;
  const day = Math.max(0, Math.min(1, elevation * 2 + 0.4));
  const top = NIGHT_TOP.clone().lerp(DAY_TOP, day);
  const horizon = NIGHT_HORIZON.clone().lerp(DAY_HORIZON, day);
  if (rain > 0) {
    top.lerp(RAIN_TOP.clone().multiplyScalar(0.3 + day * 0.7), rain * 0.8);
    horizon.lerp(RAIN_HORIZON.clone().multiplyScalar(0.3 + day * 0.7), rain * 0.8);
  }
  // A warm band while the sun is within ~20° of the horizon.
  const sunset = Math.max(0, 1 - Math.abs(elevation) * 4) * (1 - rain * 0.7);
  horizon.lerp(SUNSET, sunset * 0.35);
  const cloud = new THREE.Color(1, 1, 1).multiplyScalar(0.15 + day * 0.85).lerp(col("#ffb680"), sunset * 0.35);
  if (rain > 0) cloud.multiplyScalar(1 - rain * 0.35);
  return { sun, daylight: Math.max(0.12, daylight), top, horizon, stars: Math.max(0, 1 - day * 1.6) * (1 - rain), sunset, cloud };
}

function canvasFrom(name: string, scale = 1): THREE.CanvasTexture {
  const px = layerPixels(name);
  const c = document.createElement("canvas");
  c.width = 16 * scale; c.height = 16 * scale;
  const ctx = c.getContext("2d")!;
  const img = new ImageData(new Uint8ClampedArray(px), 16, 16);
  const tmp = document.createElement("canvas");
  tmp.width = 16; tmp.height = 16;
  tmp.getContext("2d")!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, c.width, c.height);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export class Sky {
  readonly group = new THREE.Group();
  private dome: THREE.Mesh;
  private domeMat: THREE.ShaderMaterial;
  private sunMesh: THREE.Mesh;
  private moonMesh: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh;
  private cloudMat: THREE.ShaderMaterial;
  cloudsVisible = true;

  constructor() {
    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uSunset: { value: 0 },
        uSun: { value: new THREE.Vector3() },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform float uSunset;
        uniform vec3 uSun;
        varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 col = mix(uHorizon, uTop, pow(clamp(h, 0.0, 1.0), 0.45));
          if (h < 0.0) col = mix(uHorizon, uHorizon * 0.35, clamp(-h * 3.0, 0.0, 1.0));
          vec3 flatSun = normalize(vec3(uSun.x, 0.0, uSun.z) + 1e-5);
          float toward = max(dot(normalize(vec3(d.x, 0.0, d.z) + 1e-5), flatSun), 0.0);
          float glow = pow(toward, 6.0) * uSunset * (1.0 - clamp(abs(h) * 2.5, 0.0, 1.0));
          col = mix(col, vec3(1.0, 0.5, 0.2), glow * 0.75);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), this.domeMat);
    this.dome.scale.setScalar(50);
    this.dome.renderOrder = -100;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    const sunMat = new THREE.MeshBasicMaterial({ map: canvasFrom("sun", 4), transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, fog: false });
    this.sunMesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), sunMat);
    this.sunMesh.renderOrder = -90;
    this.sunMesh.frustumCulled = false;
    const moonMat = new THREE.MeshBasicMaterial({ map: canvasFrom("moon", 4), transparent: true, depthWrite: false, depthTest: false, fog: false });
    this.moonMesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), moonMat);
    this.moonMesh.renderOrder = -90;
    this.moonMesh.frustumCulled = false;
    this.group.add(this.sunMesh, this.moonMesh);

    const rng = new Rng(10842);
    const pts: number[] = [];
    for (let i = 0; i < 1400; i++) {
      const u = rng.next() * 2 - 1, t = rng.next() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      pts.push(Math.cos(t) * s * 45, u * 45, Math.sin(t) * s * 45);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false });
    this.stars = new THREE.Points(starGeo, this.starMat);
    this.stars.renderOrder = -95;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    // Clouds: a flat layer from a thresholded noise texture, one texel per 12 blocks.
    const size = 128;
    const canvas = document.createElement("canvas");
    canvas.width = size; canvas.height = size;
    const cctx = canvas.getContext("2d")!;
    const img = cctx.createImageData(size, size);
    const noise = new Simplex(7777);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const a = (x / size) * Math.PI * 2, b = (y / size) * Math.PI * 2;
      // Sampled on a torus so the texture tiles.
      const v = noise.noise3(Math.cos(a) * 3, Math.sin(a) * 3 + Math.cos(b) * 3, Math.sin(b) * 3) * 0.7
        + noise.noise3(Math.cos(a) * 9 + 50, Math.sin(a) * 9 + Math.cos(b) * 9, Math.sin(b) * 9) * 0.3;
      const on = v > 0.12 ? 255 : 0;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = on;
    }
    cctx.putImageData(img, 0, 0);
    const cloudTex = new THREE.CanvasTexture(canvas);
    cloudTex.magFilter = THREE.NearestFilter;
    cloudTex.minFilter = THREE.NearestFilter;
    cloudTex.wrapS = cloudTex.wrapT = THREE.RepeatWrapping;
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: cloudTex },
        uOffset: { value: new THREE.Vector2() },
        uColor: { value: new THREE.Color(1, 1, 1) },
        uFade: { value: 400 },
      },
      vertexShader: `
        varying vec2 vWorld;
        varying float vDist;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xz;
          vec4 mv = viewMatrix * wp;
          vDist = length(mv.xz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform vec2 uOffset;
        uniform vec3 uColor;
        uniform float uFade;
        varying vec2 vWorld;
        varying float vDist;
        void main() {
          vec4 t = texture2D(uMap, (vWorld + uOffset) / (12.0 * 128.0));
          if (t.a < 0.5) discard;
          float a = 0.82 * (1.0 - smoothstep(uFade * 0.6, uFade, vDist));
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const plane = new THREE.PlaneGeometry(1400, 1400);
    plane.rotateX(-Math.PI / 2);
    this.clouds = new THREE.Mesh(plane, this.cloudMat);
    this.clouds.renderOrder = 3;
    this.clouds.frustumCulled = false;
    this.group.add(this.clouds);
  }

  update(camera: THREE.Camera, state: SkyState, time: number, fadeDistance: number): void {
    const cam = camera.position;
    this.dome.position.copy(cam);
    this.domeMat.uniforms.uTop.value.copy(state.top);
    this.domeMat.uniforms.uHorizon.value.copy(state.horizon);
    this.domeMat.uniforms.uSunset.value = state.sunset;
    this.domeMat.uniforms.uSun.value.copy(state.sun);

    this.sunMesh.position.copy(cam).addScaledVector(state.sun, 40);
    this.sunMesh.lookAt(cam);
    this.moonMesh.position.copy(cam).addScaledVector(state.sun, -40);
    this.moonMesh.lookAt(cam);
    this.sunMesh.visible = state.sun.y > -0.2;
    this.moonMesh.visible = state.sun.y < 0.2;

    this.stars.position.copy(cam);
    this.stars.rotation.z = Math.atan2(state.sun.y, state.sun.x);
    this.starMat.opacity = state.stars;
    this.stars.visible = state.stars > 0.01;

    this.clouds.visible = this.cloudsVisible;
    this.clouds.position.set(cam.x, 108, cam.z);
    // Clouds drift west over time, as they always have.
    this.cloudMat.uniforms.uOffset.value.set((time * 0.03) % (12 * 128), 0);
    this.cloudMat.uniforms.uColor.value.copy(state.cloud);
    this.cloudMat.uniforms.uFade.value = Math.max(120, fadeDistance * 2.2);
  }
}
