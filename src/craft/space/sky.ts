/**
 * The sky as seen from the ground: where the Sun, the Moon, the planets, the
 * comets and the stars are for someone standing at a latitude and longitude
 * at a moment, and what the sky is doing — the Moon's phase, an eclipse, a
 * meteor shower.
 *
 * Everything comes from the same ephemeris the space view flies through
 * (ephemeris.ts), seen from the observer's own place on the Earth's surface
 * rather than its centre: the Moon is close enough that the difference moves
 * it by up to a degree, which is what decides whether an eclipse is seen from
 * here or only from somewhere else.
 *
 * Directions come out in the voxel world's axes: x east, y up, z south.
 *
 * The world's clock is a game's (a day in twenty minutes), so the sky keeps a
 * date of its own that advances a real day for every game day: the Moon runs
 * through its phases in twenty-nine and a half game days, the planets creep
 * along the zodiac, and the meteor showers come round on their real dates.
 */
import { BODIES, BODY } from "./bodies";
import { ephemeris } from "./ephemeris";
import { cometActivity, tailLength } from "./comets";
import { AU, DEG, dot, eclToEq, gmst, len, norm, scale, sub, add, type Vec3 } from "./kepler";

/** How much bigger than life the Sun and Moon are drawn: at their real half a degree they would be a few pixels. */
export const DISC_SCALE = 8;

export interface SkyPlanet { id: string; dir: Vec3; mag: number; color: string }
export interface SkyComet { id: string; dir: Vec3; tail: Vec3; tailDeg: number; mag: number }
export interface Shower { name: string; parent: string; zhr: number; radiant: Vec3; rate: number }

export interface SkyObjects {
  jd: number;
  /** J2000 equatorial to local: nine numbers, row by row. */
  toLocal: number[];
  sun: Vec3;
  moon: Vec3;
  /**
   * Where the Moon is drawn. The discs are drawn DISC_SCALE times their size, so near the Sun its distance from
   * the Sun is stretched by the same factor — drawn overlap is then the real overlap, and an eclipse looks as
   * deep as it is. Away from the Sun the stretch fades to a small, constant nudge.
   */
  moonDrawn: Vec3;
  /** The Moon's lit fraction (0 new, 1 full), and the direction of the Sun seen from it, for shading its disc. */
  moonLit: number;
  /**
   * The Earth's shadow on the Moon, for a lunar eclipse: where the shadow's centre is from the Moon's (in the local
   * frame, as a direction), how far (in Moon radii), and the umbra's and penumbra's radii in Moon radii. The shadow
   * is the same for everyone on the night side, so it is worked out from the Earth's centre.
   */
  shadow: { dir: Vec3; offset: number; umbra: number; penumbra: number };
  /** How much of the Moon's disc is in the umbra (0..1): the red of a total lunar eclipse. */
  umbra: number;
  /** The Moon's north pole (IAU) in the local frame, for turning its face the way it really leans. */
  moonPole: Vec3;
  /** The Sun's and Moon's radii as drawn (radians), and how much of the Sun's disc the Moon covers (0..1). */
  sunRadius: number;
  moonRadius: number;
  eclipse: number;
  planets: SkyPlanet[];
  comets: SkyComet[];
  /** Meteor showers active now, strongest first, with their rates per hour seen from here. */
  showers: Shower[];
}

/** An equatorial direction as seen from a latitude at a local sidereal time: x east, y up, z south. */
export function horizonMatrix(latDeg: number, lstDeg: number): number[] {
  const f = latDeg * DEG, L = lstDeg * DEG;
  const cf = Math.cos(f), sf = Math.sin(f), cL = Math.cos(L), sL = Math.sin(L);
  // p = Rz(−LST)·v gives (cos δ cos H, −cos δ sin H, sin δ); then east = p2, up = sin φ p3 + cos φ p1, north = cos φ p3 − sin φ p1.
  const p1: Vec3 = [cL, sL, 0], p2: Vec3 = [-sL, cL, 0], p3: Vec3 = [0, 0, 1];
  const east = p2;
  const up: Vec3 = [sf * p3[0] + cf * p1[0], sf * p3[1] + cf * p1[1], sf * p3[2] + cf * p1[2]];
  const north: Vec3 = [cf * p3[0] - sf * p1[0], cf * p3[1] - sf * p1[1], cf * p3[2] - sf * p1[2]];
  // Rows: x = east, y = up, z = −north (south).
  return [...east, ...up, -north[0], -north[1], -north[2]];
}

export function applyMatrix(m: number[], v: Vec3): Vec3 {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/**
 * The sky's date for a world's clock: game day `day` is real day `epoch + day`,
 * and the time of day is local solar time — the game's noon (6000) is noon
 * at the world's longitude.
 */
export function skyJd(time: number, epoch: number, lon: number): number {
  const day = Math.floor(time / 24000);
  // Tick 0 is six in the morning; hours past 24 run on into the next date.
  const localHours = ((time % 24000) / 24000) * 24 + 6;
  return epoch + day + (localHours - lon / 15) / 24;
}

/**
 * The world's clock and epoch that put the sky at a moment (a Julian date) over a longitude, keeping the world's
 * count of days: the time of day becomes that local solar time, and the epoch moves so the day is that date.
 */
export function clockFor(jd: number, lon: number, time: number): { time: number; epoch: number } {
  const x = jd + lon / 360 - 0.25;
  const frac = (((x - 0.5) % 1) + 1) % 1;
  const day = Math.floor(time / 24000);
  return { time: day * 24000 + Math.round(frac * 24000), epoch: x - frac - day };
}

/** An epoch that makes today's game day today's real date. */
export function epochForToday(time: number, nowJd: number): number {
  const midnight = Math.floor(nowJd - 0.5) + 0.5;
  return midnight - Math.floor(time / 24000);
}

/** The meteor showers of the year (International Meteor Organization): their peak by the Sun's longitude, their rate, their radiant, their parent. */
export const SHOWERS: { name: string; parent: string; peak: number; zhr: number; ra: number; dec: number; days: number }[] = [
  { name: "Quadrantids", parent: "asteroid 2003 EH1", peak: 283.15, zhr: 110, ra: 230, dec: 49, days: 0.6 },
  { name: "Lyrids", parent: "comet Thatcher", peak: 32.32, zhr: 18, ra: 271, dec: 34, days: 1.3 },
  { name: "Eta Aquariids", parent: "Halley's Comet", peak: 45.5, zhr: 50, ra: 338, dec: -1, days: 5 },
  { name: "Southern Delta Aquariids", parent: "comet 96P/Machholz", peak: 125, zhr: 25, ra: 340, dec: -16, days: 5 },
  { name: "Perseids", parent: "comet Swift–Tuttle", peak: 140.0, zhr: 100, ra: 48, dec: 58, days: 2.5 },
  { name: "Draconids", parent: "comet Giacobini–Zinner", peak: 195.4, zhr: 10, ra: 262, dec: 54, days: 0.6 },
  { name: "Southern Taurids", parent: "Comet Encke", peak: 197, zhr: 5, ra: 32, dec: 9, days: 20 },
  { name: "Orionids", parent: "Halley's Comet", peak: 208, zhr: 20, ra: 95, dec: 16, days: 4 },
  { name: "Northern Taurids", parent: "Comet Encke", peak: 230, zhr: 5, ra: 58, dec: 22, days: 20 },
  { name: "Leonids", parent: "comet Tempel–Tuttle", peak: 235.27, zhr: 15, ra: 152, dec: 22, days: 1 },
  { name: "Geminids", parent: "asteroid Phaethon", peak: 262.2, zhr: 150, ra: 112, dec: 33, days: 1.5 },
  { name: "Ursids", parent: "comet 8P/Tuttle", peak: 270.7, zhr: 10, ra: 217, dec: 76, days: 0.6 },
];

/** The Sun's ecliptic longitude seen from the Earth (degrees): the date of the year as the sky counts it. */
export function solarLongitude(earthHelio: Vec3): number {
  return ((Math.atan2(-earthHelio[1], -earthHelio[0]) / DEG) % 360 + 360) % 360;
}

/** Each shower's zenithal hourly rate at a solar longitude, falling away either side of its peak. */
export function showerRates(lambda: number): { name: string; parent: string; zhr: number; ra: number; dec: number }[] {
  const out: { name: string; parent: string; zhr: number; ra: number; dec: number }[] = [];
  for (const s of SHOWERS) {
    const d = ((lambda - s.peak + 540) % 360) - 180;
    const width = s.days * 0.9856;
    const zhr = s.zhr * Math.exp(-((d / width) ** 2));
    if (zhr >= 1) out.push({ name: s.name, parent: s.parent, zhr, ra: s.ra, dec: s.dec });
  }
  return out.sort((a, b) => b.zhr - a.zhr);
}

/** Planets' absolute magnitudes, for how bright they look: V(1,0) from the Astronomical Almanac, rounded. */
const PLANET_MAG: Record<string, [number, string]> = {
  mercury: [-0.613, "#e8dcc8"], venus: [-4.384, "#fffbe8"], mars: [-1.5, "#ff9a6a"], jupiter: [-9.4, "#fff2d8"], saturn: [-8.9, "#ffe6b0"], uranus: [-7.2, "#c8f0f4"], neptune: [-6.9, "#a8c0ff"],
};
/**
 * How much fainter a planet is at a phase angle than full, in magnitudes: Mallama and Hilton's (2018) fits for
 * Mercury and Venus, whose crescents are the ones we see, and a straight line for the rest (which only show us
 * a nearly full face).
 */
function phaseLaw(id: string, a: number): number {
  if (id === "mercury") return 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6;
  if (id === "venus") return a < 163.7 ? -1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4 : 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2 + 4.384;
  return 0.015 * a;
}

/** Comets' absolute magnitudes (the brightness at 1 AU from both Sun and Earth), for the ones that get bright. */
const COMET_MAG: Record<string, number> = { halley: 5.5, encke: 11.5, swifttuttle: 4, tempeltuttle: 9, halebopp: -0.8, hyakutake: 7.3, mcnaught: 5.4, neowise: 6.8, cg67p: 11, borisov: 13 };

/** The area of the smaller of two overlapping discs covered by the larger, as a fraction of the first disc. */
export function discOverlap(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r2 - r1)) return r2 >= r1 ? 1 : (r2 * r2) / (r1 * r1);
  const a = r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1));
  const b = r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2));
  const c = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
  return (a + b - c) / (Math.PI * r1 * r1);
}

/**
 * How much daylight is left while the Moon covers a share of the Sun. The eye
 * forgives a partial eclipse — at nine-tenths covered the day only looks
 * overcast — and then the last sliver goes and it is suddenly dusk all round:
 * the last one per cent of the Sun still outshines everything else in the sky
 * ten thousand times over.
 */
export function eclipseLight(coverage: number): number {
  const t = Math.max(0, Math.min(1, (coverage - 0.98) / 0.02));
  return 1 - 0.55 * coverage ** 4 - 0.33 * t * t * (3 - 2 * t);
}

/** The sky at a Julian date over a latitude and longitude. */
export function skyAt(jd: number, lat: number, lon: number): SkyObjects {
  const e = ephemeris(jd);
  const earth = e.get("earth")!;
  const lst = gmst(jd) + lon;
  const m = horizonMatrix(lat, lst);
  // The observer, on the surface: the Earth's centre plus a radius toward the zenith (in the ecliptic frame).
  const zenithEq: Vec3 = [Math.cos(lat * DEG) * Math.cos(lst * DEG), Math.cos(lat * DEG) * Math.sin(lst * DEG), Math.sin(lat * DEG)];
  const c = Math.cos(23.4392911 * DEG), s = Math.sin(23.4392911 * DEG);
  const zenithEcl: Vec3 = [zenithEq[0], zenithEq[1] * c + zenithEq[2] * s, -zenithEq[1] * s + zenithEq[2] * c];
  const here = add(earth, scale(zenithEcl, 6371));
  const local = (helio: Vec3): Vec3 => applyMatrix(m, norm(eclToEq(sub(helio, here))));

  const sunRel = sub([0, 0, 0], here), moonRel = sub(e.get("moon")!, here);
  const sun = local([0, 0, 0]), moon = local(e.get("moon")!);
  const sunRadius = Math.asin(BODY.sun.radius / len(sunRel)) * DISC_SCALE;
  const moonRadius = Math.asin(BODY.moon.radius / len(moonRel)) * DISC_SCALE;
  const sep = Math.acos(Math.max(-1, Math.min(1, dot(norm(sunRel), norm(moonRel)))));
  // The Moon's lit fraction from the Sun–Moon angle seen from here (its elongation).
  const moonLit = (1 - Math.cos(sep)) / 2;
  const eclipse = discOverlap(sunRadius, moonRadius, sep * DISC_SCALE);
  // Stretched near the Sun, where it decides how an eclipse looks; faded back to the true place by ten degrees out,
  // so the Moon stands among the right stars. The fade is slow enough that the drawn distance still only grows.
  const theta0 = 0.8 * DEG, theta1 = 4 * DEG;
  const drawnSep = sep + (DISC_SCALE - 1) * theta0 * Math.tanh(sep / theta0) * Math.exp(-sep / theta1);
  // Turn the Sun's direction toward the Moon's, through the drawn separation.
  const toward = norm(sub(moon, scale(sun, dot(moon, sun))));
  const moonDrawn = sep < 1e-9 ? moon : norm(add(scale(sun, Math.cos(drawnSep)), scale(toward, Math.sin(drawnSep))));

  // The Earth's shadow where the Moon is, with the 2% its air adds (Danjon), seen from the Earth's centre.
  const RE = 6378.137, geo = sub(e.get("moon")!, earth), dist = len(geo), toMoon = norm(geo), axis = norm(earth);
  const pm = Math.asin(RE / dist), sunR = Math.asin(BODY.sun.radius / len(earth)), ps = Math.asin(RE / len(earth));
  const moonR = Math.asin(BODY.moon.radius / dist);
  const off = Math.acos(Math.max(-1, Math.min(1, dot(toMoon, axis))));
  const shadowLocal = applyMatrix(m, eclToEq(axis)), moonLocal = applyMatrix(m, eclToEq(toMoon));
  const shadow = {
    dir: norm(sub(shadowLocal, scale(moonLocal, dot(shadowLocal, moonLocal)))),
    offset: off / moonR, umbra: (1.02 * (pm - sunR + ps)) / moonR, penumbra: (1.02 * (pm + sunR + ps)) / moonR,
  };
  const umbra = discOverlap(1, shadow.umbra, shadow.offset);
  const [pra, pdec] = BODY.moon.pole!;
  const moonPole = applyMatrix(m, [Math.cos(pdec * DEG) * Math.cos(pra * DEG), Math.cos(pdec * DEG) * Math.sin(pra * DEG), Math.sin(pdec * DEG)]);

  const planets: SkyPlanet[] = [];
  for (const [id, [v0, color]] of Object.entries(PLANET_MAG)) {
    const p = e.get(id);
    if (!p) continue;
    const r = len(p) / AU, delta = len(sub(p, here)) / AU;
    const phase = Math.acos(Math.max(-1, Math.min(1, dot(norm(sub(here, p)), norm(sub([0, 0, 0], p)))))) / DEG;
    planets.push({ id, dir: local(p), mag: v0 + 5 * Math.log10(r * delta) + phaseLaw(id, phase), color });
  }
  const comets: SkyComet[] = [];
  for (const b of BODIES) {
    if ((b.kind !== "comet" && b.kind !== "interstellar") || COMET_MAG[b.id] === undefined) continue;
    const p = e.get(b.id);
    if (!p) continue;
    const r = len(p) / AU, delta = len(sub(p, here)) / AU;
    const mag = COMET_MAG[b.id] + 5 * Math.log10(delta) + 10 * Math.log10(r);
    if (mag > 6.5 || cometActivity(b, p) <= 0) continue;
    const L = tailLength(b, p);
    const end = add(p, scale(norm(p), L));
    const a = local(p), z = local(end);
    const tailDeg = Math.acos(Math.max(-1, Math.min(1, dot(a, z)))) / DEG;
    comets.push({ id: b.id, dir: a, tail: norm(sub(z, a)), tailDeg, mag });
  }
  const showers: Shower[] = [];
  for (const sh of showerRates(solarLongitude(earth))) {
    const radiant = applyMatrix(m, [Math.cos(sh.dec * DEG) * Math.cos(sh.ra * DEG), Math.cos(sh.dec * DEG) * Math.sin(sh.ra * DEG), Math.sin(sh.dec * DEG)]);
    showers.push({ name: sh.name, parent: sh.parent, zhr: sh.zhr, radiant, rate: sh.zhr * Math.max(0, radiant[1]) });
  }
  return { jd, toLocal: m, sun, moon, moonDrawn, moonLit, shadow, umbra, moonPole, sunRadius, moonRadius, eclipse, planets, comets, showers };
}

// ---- the calendar ----------------------------------------------------------------------------------------------

/** The Moon's elongation from the Sun seen from the Earth's centre, signed: waxing positive, 0 at new moon, 180 at full. */
export function elongation(jd: number): number {
  const e = ephemeris(jd);
  const earth = e.get("earth")!, moon = sub(e.get("moon")!, earth), sun = sub([0, 0, 0], earth);
  const lon = (v: Vec3) => Math.atan2(v[1], v[0]) / DEG;
  return ((lon(moon) - lon(sun)) % 360 + 360) % 360;
}

/** The next moment after `jd` the Moon reaches a phase (0 new, 90 first quarter, 180 full, 270 last quarter). */
export function nextPhase(jd: number, phase: number): number {
  const synodic = 29.530589;
  const now = elongation(jd);
  let t = jd + (((phase - now + 360) % 360) / 360) * synodic;
  // Newton on the elongation, which runs at about 12.2° a day.
  for (let i = 0; i < 12; i++) {
    const d = ((elongation(t) - phase + 540) % 360) - 180;
    t -= d / 12.19;
    if (Math.abs(d) < 1e-4) break;
  }
  return t <= jd ? nextPhase(jd + 1, phase) : t;
}

export interface Eclipse { jd: number; kind: "solar" | "lunar"; type: "total" | "annular" | "partial" | "penumbral"; }

/**
 * Eclipses from a date on. At each new and full moon: γ, how far (in Earth
 * radii) the line from the Sun through the Earth passes from the Moon's
 * centre, against the sizes of the shadows where the Moon is — the Earth's
 * umbra and penumbra (enlarged by 2% for its air, as Danjon found) for a lunar
 * eclipse; the Earth itself for a solar one, total or annular by whether the
 * Moon looks bigger than the Sun.
 */
export function eclipsesFrom(jd: number, count: number): Eclipse[] {
  const out: Eclipse[] = [];
  const RE = 6378.137, k = BODY.moon.radius / RE;
  let t = jd;
  for (let guard = 0; out.length < count && guard < 200; guard++) {
    const nm = nextPhase(t, 0), fm = nextPhase(t, 180);
    const next = Math.min(nm, fm);
    const kind = next === nm ? "solar" : "lunar";
    const e = ephemeris(next);
    const earth = e.get("earth")!, moon = sub(e.get("moon")!, earth);
    const dist = len(moon);
    const gamma = Math.abs(moon[2]) / RE;
    if (kind === "solar") {
      if (gamma < 1.0 + k * 2) {
        const bigger = Math.asin(BODY.moon.radius / (dist - RE)) > Math.asin(BODY.sun.radius / len(earth));
        out.push({ jd: next, kind, type: gamma < 0.997 ? (bigger ? "total" : "annular") : "partial" });
      }
    } else {
      const pm = Math.asin(RE / dist), sunR = Math.asin(BODY.sun.radius / len(earth)), ps = Math.asin(RE / len(earth));
      const umbra = (1.02 * (pm - sunR + ps)) / pm, penumbra = (1.02 * (pm + sunR + ps)) / pm;
      if (gamma < penumbra + k) out.push({ jd: next, kind, type: gamma < umbra - k ? "total" : gamma < umbra + k ? "partial" : "penumbral" });
    }
    t = next + 1;
  }
  return out;
}

/**
 * How much of the Sun an eclipse covers at its deepest from a place: the sky
 * worked out every few minutes either side of the new moon.
 */
export function localEclipse(jd: number, lat: number, lon: number): { coverage: number; at: number } {
  let best = { coverage: 0, at: jd };
  for (let m = -240; m <= 240; m += 6) {
    const t = jd + m / 1440;
    const c = skyAt(t, lat, lon).eclipse;
    if (c > best.coverage) best = { coverage: c, at: t };
  }
  return best;
}
/**
 * Where on the Earth a solar eclipse is greatest: the moment near a new moon
 * when the line from the Sun through the Moon passes closest to the Earth's
 * centre, and the point where that line meets the ground. The Earth here is
 * the same round one of radius 6,371 km that skyAt stands its observer on,
 * so the place found is one skyAt puts under the Moon's shadow. Null if the
 * line misses the Earth (a partial eclipse has no centre on the ground).
 */
export function eclipseCentre(jd: number): { jd: number; lat: number; lon: number } | null {
  const RE = 6371;
  const miss = (t: number) => {
    const e = ephemeris(t);
    const earth = e.get("earth")!, u = norm(e.get("moon")!);
    const along = dot(earth, u);
    return { d: len(sub(earth, scale(u, along))), along, earth, u };
  };
  let best = jd, bestD = Infinity;
  for (let m = -360; m <= 360; m += 4) {
    const d = miss(jd + m / 1440).d;
    if (d < bestD) { bestD = d; best = jd + m / 1440; }
  }
  // The miss distance has one minimum near there: close in on it by thirds.
  let lo = best - 4 / 1440, hi = best + 4 / 1440;
  for (let i = 0; i < 40; i++) {
    const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3;
    if (miss(a).d < miss(b).d) hi = b; else lo = a;
  }
  best = (lo + hi) / 2;
  const { d, along, earth, u } = miss(best);
  if (d >= RE) return null;
  const t = along - Math.sqrt(RE * RE - d * d);
  const ground = sub(scale(u, t), earth);
  const q = eclToEq(norm(ground));
  const lat = Math.asin(q[2]) / DEG;
  const lon = ((((Math.atan2(q[1], q[0]) / DEG - gmst(best)) % 360) + 540) % 360) - 180;
  return { jd: best, lat, lon };
}
