/**
 * A trip to space: the Solar System's clock, the ship, the camera, what is
 * selected, and the orders — everything between a launch and a landing.
 *
 * The clock is the real one (the planets are where they are today) until
 * the player speeds it up; the ship keeps its own time whatever the clock
 * does, as a ship in EVE would, while the worlds sweep round their orbits.
 *
 * The Earth under the ship is this world: a launch goes up from where the
 * player stands, placed on the globe from the world's own anchor (a latitude
 * and longitude chosen from its seed) at one block to the metre, and a landing
 * comes down wherever on Earth the ship is — which is somewhere in this world,
 * however far from home.
 */
import { BODIES, BODY, kindLabel, type BodyDef } from "./bodies";
import { ephemeris, planetConic } from "./ephemeris";
import { AU, eclToEq, eqToEcl, gmst, jdFromMs, len, norm, sub, type Vec3 } from "./kepler";
import {
  aboveEarth, belowShip, MIN_WARP, newShip, order, SCOUT, shipPosition, step, warpInDistance, warpRefusal, warpTime, type Order, type Ship, type Surroundings,
} from "./flight";
import type { SpaceCameraState, SpaceFrame } from "./spaceView";

/** How fast the clock may run: from real time to a month a second. */
export const TIME_SCALES = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000, 3_000_000];

/** Metres in a degree of latitude, and of longitude at the equator: the world is the Earth at one block to the metre. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;
/** The farthest a landing can put anyone from the world's centre, in blocks: inside the world's border. */
const WORLD_REACH = 29_000_000;

export interface OverviewRow {
  id: string;
  name: string;
  kind: string;
  type: string;
  /** From the ship to its surface, km. */
  distance: number;
}

export type OverviewTab = "planets" | "moons" | "small" | "all";

/** Which latitude and longitude a world's origin sits at: somewhere people live, chosen from the seed. */
export function worldAnchor(seed: number): { lat: number; lon: number } {
  const a = Math.abs(Math.sin(seed * 12.9898) * 43758.5453) % 1, b = Math.abs(Math.sin(seed * 78.233) * 12543.123) % 1;
  return { lat: -40 + a * 95, lon: -180 + b * 360 };
}

/** A block position in the world as a place on Earth. */
export function blockToLatLon(seed: number, x: number, z: number): { lat: number; lon: number } {
  const o = worldAnchor(seed);
  const lat = Math.max(-89, Math.min(89, o.lat - z / M_PER_DEG_LAT));
  const lon = ((o.lon + x / (M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180)) + 540) % 360) - 180;
  return { lat, lon };
}

/** A place on Earth as a block position in the world — kept inside the world's border. */
export function latLonToBlock(seed: number, lat: number, lon: number): { x: number; z: number } {
  const o = worldAnchor(seed);
  const dLon = ((lon - o.lon + 540) % 360) - 180;
  const x = dLon * M_PER_DEG_LON * Math.cos((lat * Math.PI) / 180);
  const z = (o.lat - lat) * M_PER_DEG_LAT;
  const clamp = (v: number) => Math.max(-WORLD_REACH, Math.min(WORLD_REACH, v));
  return { x: clamp(x), z: clamp(z) };
}

/** How far each body's neighbourhood reaches (km): its sphere of influence, or a patch of space around a small one. */
function reaches(): { id: string; reach: number }[] {
  const out: { id: string; reach: number }[] = [];
  for (const b of BODIES) {
    if (b.kind === "star") continue;
    const parent = b.parent ? BODY[b.parent] : null;
    let reach: number;
    if (b.gm && parent?.gm) {
      const o = b.orbit;
      const a = o.kind === "planet" ? planetConic(o.index, 2451545).q / (1 - planetConic(o.index, 2451545).e) * AU
        : o.kind === "equatorial" ? o.a : o.kind === "moon" ? 384_400 : o.kind === "conic" ? (o.conic.q / (1 - Math.min(0.99, o.conic.e))) * AU : b.radius * 100;
      reach = a * Math.pow(b.gm / parent.gm, 0.4);
    } else if (b.kind === "comet" || b.kind === "interstellar") reach = 200_000;
    else reach = Math.max(b.radius * 100, 3000);
    out.push({ id: b.id, reach: Math.max(reach, b.radius * 3) });
  }
  return out.sort((a, b) => a.reach - b.reach);
}

export class SpaceSession {
  jd: number;
  timeScale = 1;
  ship: Ship;
  camera: SpaceCameraState;
  selected: string | null = null;
  hovered: string | null = null;
  tab: OverviewTab = "planets";
  orbits = new Set<string>(["planet", "dwarf"]);
  positions = new Map<string, Vec3>();
  shipHelio: Vec3 = [0, 0, 0];
  /** The last thing worth saying (a warp engaged, an order refused), and when. */
  note: { text: string; at: number } | null = null;
  /** Counting down to landing, seconds; null when not landing. */
  landing: number | null = null;
  private readonly places = reaches();
  private clock = 0;

  constructor(readonly seed: number, launch: { lat: number; lon: number }, jd = jdFromMs(Date.now())) {
    this.jd = jd;
    const up = aboveEarth(launch.lat, launch.lon, 400, gmst(jd), eqToEcl);
    this.ship = newShip(SCOUT, "earth", up.pos, up.heading);
    // Behind and a little above the ship, looking along its path with the Earth's curve below.
    const back = sub([0, 0, 0], up.heading), radial = norm(up.pos);
    const off = norm([back[0] + radial[0] * 0.35, back[1] + radial[1] * 0.35, back[2] + radial[2] * 0.35]);
    this.camera = { target: "ship", yaw: Math.atan2(off[1], off[0]), pitch: Math.asin(off[2]), dist: 0.16 };
    this.refresh();
  }

  get surroundings(): Surroundings {
    return { pos: (id) => this.positions.get(id) ?? null, radius: (id) => BODY[id]?.radius ?? 1, places: this.places };
  }

  private refresh(): void {
    this.positions = ephemeris(this.jd);
    this.shipHelio = shipPosition(this.ship, this.surroundings);
  }

  /** One frame: the clock, then the ship in steps small enough for its orders to stay smooth. */
  update(dt: number): void {
    this.clock += dt;
    this.jd += (dt * this.timeScale) / 86400;
    this.refresh();
    const w = this.surroundings;
    const n = Math.max(1, Math.ceil(dt / (1 / 30)));
    for (let i = 0; i < n; i++) {
      const e = step(this.ship, w, dt / n);
      if (e === "warp") this.say(`Warp drive active — ${BODY[this.ship.warp!.target]?.name}`);
      if (e === "arrived") this.say(`Arrived: ${BODY[this.ship.frame]?.name ?? "deep space"}`);
    }
    this.shipHelio = shipPosition(this.ship, w);
    if (this.landing !== null) this.landing = Math.max(0, this.landing - dt);
  }

  frame(dt: number): SpaceFrame {
    const listed = new Set(this.rows().map((r) => r.id));
    return {
      jd: this.jd, dt, positions: this.positions, ship: this.ship, shipHelio: this.shipHelio, camera: this.camera,
      selected: this.selected, hovered: this.hovered, orbits: this.orbits, listed,
    };
  }

  say(text: string): void {
    this.note = { text, at: this.clock };
  }

  noteText(): string | null {
    return this.note && this.clock - this.note.at < 5 ? this.note.text : null;
  }

  // ---- the overview ------------------------------------------------------------------------------------------------

  private inTab(b: BodyDef): boolean {
    switch (this.tab) {
      case "planets": return b.kind === "star" || b.kind === "planet" || b.kind === "dwarf";
      case "moons": {
        // The moons of wherever the ship is, or of the planet it is nearest.
        const home = this.homePlanet();
        return b.kind === "moon" && b.parent === home;
      }
      case "small": return b.kind === "asteroid" || b.kind === "comet" || b.kind === "interstellar" || b.kind === "probe";
      case "all": return true;
    }
  }

  /** The planet (or dwarf planet) the ship is at or nearest to. */
  homePlanet(): string {
    let id = this.ship.frame;
    while (id && BODY[id] && BODY[id].kind === "moon") id = BODY[id].parent!;
    if (BODY[id] && (BODY[id].kind === "planet" || BODY[id].kind === "dwarf")) return id;
    let best = "earth", bestD = Infinity;
    for (const b of BODIES) {
      if (b.kind !== "planet") continue;
      const p = this.positions.get(b.id);
      if (p) { const d = len(sub(p, this.shipHelio)); if (d < bestD) { bestD = d; best = b.id; } }
    }
    return best;
  }

  rows(): OverviewRow[] {
    const out: OverviewRow[] = [];
    for (const b of BODIES) {
      const p = this.positions.get(b.id);
      if (!p || !this.inTab(b)) continue;
      out.push({ id: b.id, name: b.name, kind: b.kind, type: kindLabel(b), distance: Math.max(0, len(sub(p, this.shipHelio)) - b.radius) });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  distanceTo(id: string): number {
    const p = this.positions.get(id);
    return p ? Math.max(0, len(sub(p, this.shipHelio)) - (BODY[id]?.radius ?? 0)) : Infinity;
  }

  // ---- orders ----------------------------------------------------------------------------------------------------------

  select(id: string | null): void {
    this.selected = id && BODY[id] ? id : null;
  }

  give(o: Order): boolean {
    if (this.landing !== null) return false;
    if (this.ship.warp) { this.say("The ship is in warp: orders wait until it drops out."); return false; }
    if (o.kind === "warp") {
      const why = warpRefusal(this.ship, this.surroundings, o.target, o.range);
      if (why) { this.say(why); return false; }
      const d = this.distanceTo(o.target);
      this.say(`Aligning to ${BODY[o.target].name} — warp in about ${Math.round(warpTime(this.ship.cls, d) + this.ship.cls.tau * 1.4)} s`);
    }
    order(this.ship, o);
    return true;
  }

  warpTo(id: string, range: number): boolean {
    return this.give({ kind: "warp", target: id, range });
  }

  /** Whether the target is far enough away to warp to. */
  canWarp(id: string): boolean {
    const p = this.positions.get(id);
    if (!p) return false;
    return len(sub(p, this.shipHelio)) - warpInDistance(BODY[id].radius, 0) > MIN_WARP;
  }

  setTimeScale(k: number): void {
    this.timeScale = Math.max(1, Math.min(TIME_SCALES[TIME_SCALES.length - 1], k));
  }

  faster(): void {
    const i = TIME_SCALES.findIndex((k) => k > this.timeScale);
    this.setTimeScale(i < 0 ? this.timeScale : TIME_SCALES[i]);
  }

  slower(): void {
    const lower = TIME_SCALES.filter((k) => k < this.timeScale);
    this.setTimeScale(lower.length ? lower[lower.length - 1] : 1);
  }

  /** Back to the real date and time, at real speed. */
  now(): void {
    this.jd = jdFromMs(Date.now());
    this.timeScale = 1;
  }

  /** The camera circles the ship, or looks at a body from a sensible distance. */
  lookAt(id: string | null): void {
    if (!id || id === "ship") { this.camera = { ...this.camera, target: "ship", dist: Math.min(this.camera.dist, 5) }; return; }
    const b = BODY[id];
    if (!b) return;
    const extent = b.rings ? b.rings.outer : b.radius;
    this.camera = { ...this.camera, target: id, dist: Math.max(extent * 3.2, 1) };
  }

  zoom(factor: number): void {
    const min = this.camera.target === "ship" ? 0.06 : (BODY[this.camera.target]?.radius ?? 1) * 1.05;
    this.camera.dist = Math.max(min, Math.min(80 * AU, this.camera.dist * factor));
  }

  turn(dyaw: number, dpitch: number): void {
    this.camera.yaw += dyaw;
    this.camera.pitch = Math.max(-1.52, Math.min(1.52, this.camera.pitch + dpitch));
  }

  // ---- landing ---------------------------------------------------------------------------------------------------------

  /** Where below the ship, if it is low enough over the Earth to come down. */
  landingSite(): { lat: number; lon: number; altitude: number } | null {
    if (this.ship.frame !== "earth" || this.ship.warp) return null;
    const under = belowShip(this.ship.pos, gmst(this.jd), eclToEq);
    return under.altitude < 2000 ? under : null;
  }

  /** Where in the world the landing site is. */
  landingBlock(): { x: number; z: number; lat: number; lon: number } | null {
    const s = this.landingSite();
    if (!s) return null;
    return { ...latLonToBlock(this.seed, s.lat, s.lon), lat: s.lat, lon: s.lon };
  }

  /** Local solar time at a longitude, in hours: for setting the day to match where the ship came down. */
  solarHours(lon: number): number {
    const utc = ((this.jd + 0.5) % 1) * 24;
    return (((utc + lon / 15) % 24) + 24) % 24;
  }
}
