/**
 * The city and casino modes' runtimes. The casino games themselves are each
 * player's own, played on their own screen (ui/CasinoScreens.tsx); what runs
 * here, on the host, is the house: the stake it hands each player on the way
 * in, and the goal on the board.
 *
 * A city mode also keeps the city alive round its players, and only there:
 * traffic on the lanes and people on the sidewalks within a block or two of
 * someone, cars parked in the lots as they come near, all of it tidied away
 * again once everyone has gone. None of that is saved — it is the city's,
 * not the player's — and a car a player was given is kept.
 */
import type { Objective } from "../game/types";
import { Car, CAR_COLORS, type CarModelId } from "../engine/cars";
import { STREET, type City, LOT } from "../engine/city";
import { Mob } from "../engine/mobs";
import { laneNear, laneSpot, newTraffic, sidewalkSpot, trafficDrive, type TrafficState } from "../engine/traffic";
import { ModeRuntime, registerRuntime } from "./runtime";

/** Dollars a player starts High Roller with. */
export const HIGH_ROLLER_STAKE = 1000;

class HighRollerRuntime extends ModeRuntime {
  private get given(): string[] { return ((this.data.given as string[] | undefined) ??= []); }

  start(): void {
    this.title(null, "The Golden Stonk", "A thousand dollars. Make it a million.");
    this.tell(null, "Walk up to a machine or a table and use it to play: slots, blackjack, roulette, video poker on the east wall, the wheel on the north, and the Stonks terminal on the west.", "#ffcc66");
  }

  second(): void {
    // Everyone gets their stake once, whenever they walk in.
    for (const p of this.players()) {
      if (this.given.includes(p.name)) continue;
      this.given.push(p.name);
      this.giveCash(p.id, HIGH_ROLLER_STAKE);
    }
  }

  objective(): Objective {
    return { title: "The Golden Stonk", lines: [["Goal", "$1,000,000"], ["Stake", `$${HIGH_ROLLER_STAKE.toLocaleString("en-US")}`]] };
  }

  restart(): string {
    this.data.given = [];
    return "Everyone gets a fresh thousand on the house.";
  }
}

registerRuntime("high_roller", (g, d, s) => new HighRollerRuntime(g, d, s));

/** What the traffic drives, and how often. */
const TRAFFIC_MIX: [CarModelId, number][] = [["sedan", 30], ["compact", 18], ["taxi", 14], ["pickup", 10], ["van", 8], ["muscle", 8], ["sports", 7], ["police", 3], ["super", 2]];

function weighted<T>(table: [T, number][], random: () => number): T {
  let roll = random() * table.reduce((t, [, w]) => t + w, 0);
  for (const [v, w] of table) if ((roll -= w) < 0) return v;
  return table[0][0];
}

/**
 * The base of every mode played in a city: it drives the traffic, and keeps
 * the streets populated round each player and empty everywhere else.
 */
export abstract class CityRuntime extends ModeRuntime {
  /** Traffic brains by car id: the host's alone, and never saved. */
  private readonly brains = new Map<number, TrafficState>();
  /** Lots whose parked cars are out, so they are not parked twice. */
  private readonly parked = new Set<string>();
  protected trafficPerPlayer = 11;
  protected peoplePerPlayer = 16;

  city(): City | null {
    return this.layout()?.city ?? null;
  }

  tick(): void {
    const city = this.city();
    if (!city || !this.home) return;
    const g = this.game;
    const players = g.playerRefs();
    for (const e of g.entities.values()) {
      if (!(e instanceof Car) || e.removed) continue;
      if (e.wrecked === 2 && this.state.started) this.onCarWrecked();
      if (e.rider) { e.lastDriver = e.rider; this.brains.delete(e.id); continue; }
      if (!e.npc || e.wrecked) { this.brains.delete(e.id); continue; }
      let st = this.brains.get(e.id);
      if (!st) {
        // A car the city lost track of (brought back from the host's last session): the lane it is on now.
        st = newTraffic(laneNear(city, e.x, e.z, e.yaw), g.ctx.random);
        this.brains.set(e.id, st);
      }
      trafficDrive(city, e, st, g.ctx, g.ctx.entitiesNear(e.x, e.y, e.z, 18), players);
    }
    if (g.tickCount % 20 === 0) this.populate(city);
  }

  /** Tidies away what nobody is near, and fills the streets round whoever is. */
  private populate(city: City): void {
    const g = this.game;
    const here = this.alive().map((p) => ({ x: p.x, z: p.z }));
    const far = (x: number, z: number, d: number) => here.every((p) => Math.hypot(p.x - x, p.z - z) > d);
    let traffic = 0, people = 0;
    for (const e of g.entities.values()) {
      if (e instanceof Car && e.ambient && !e.rider) {
        if (far(e.x, e.z, e.wrecked ? 70 : 120)) { e.removed = true; this.brains.delete(e.id); } else if (e.npc) traffic++;
      } else if (e instanceof Mob && e.kind === "citizen" && !e.dying) {
        if (far(e.x, e.z, 90)) e.removed = true; else people++;
      }
    }
    for (const key of [...this.parked]) {
      const [i, j] = key.split(",").map(Number);
      const lot = city.lot(i, j);
      if (far(lot.x0 + LOT / 2, lot.z0 + LOT / 2, 130)) this.parked.delete(key);
    }
    const random = g.ctx.random;
    for (const p of here) {
      if (traffic < this.trafficPerPlayer * here.length) {
        const spot = laneSpot(city, random, p, 40, 90);
        if (spot && g.world.isLoaded(Math.floor(spot.x), Math.floor(spot.z)) && g.ctx.entitiesNear(spot.x, STREET, spot.z, 7).length === 0) {
          const model = weighted(TRAFFIC_MIX, random);
          const car = new Car(spot.x, STREET, spot.z, model, Math.floor(random() * CAR_COLORS.length));
          car.yaw = car.prevYaw = spot.yaw;
          car.npc = true;
          const st = newTraffic(spot.lane, random);
          car.body.vx = -Math.sin(spot.yaw) * st.cruise; car.body.vz = -Math.cos(spot.yaw) * st.cruise;
          g.spawn(car);
          this.brains.set(car.id, st);
          traffic++;
        }
      }
      if (people < this.peoplePerPlayer * here.length) {
        const spot = sidewalkSpot(city, random, p, 18, 60);
        if (spot && g.world.isLoaded(Math.floor(spot.x), Math.floor(spot.z))) {
          g.spawn(new Mob("citizen", spot.x, STREET, spot.z));
          people++;
        }
      }
      // Parked cars in the lots as they come near.
      for (let di = -2; di <= 2; di++) for (let dj = -2; dj <= 2; dj++) {
        const ai = city.across(Math.floor(p.x), true), aj = city.across(Math.floor(p.z), false);
        if (!ai || !aj) continue;
        const i = ("lot" in ai ? ai.lot : ai.road) + di, j = ("lot" in aj ? aj.lot : aj.road) + dj;
        if (i < 0 || j < 0 || i >= city.spec.cols || j >= city.spec.rows) continue;
        const key = `${i},${j}`;
        if (this.parked.has(key)) continue;
        const lot = city.lot(i, j);
        if (!lot.parking.length || !g.world.isLoaded(lot.x0, lot.z0) || !g.world.isLoaded(lot.x0 + LOT - 1, lot.z0 + LOT - 1)) continue;
        this.parked.add(key);
        for (const [x, y, z, yaw] of lot.parking) {
          if (lot.landmark?.kind === "safehouse" || random() < 0.35) continue;
          if (g.ctx.entitiesNear(x, y, z, 2.5).length) continue;
          const model = lot.landmark?.kind === "police" ? "police" : lot.landmark?.kind === "dealer" ? weighted<CarModelId>([["sports", 3], ["super", 1], ["muscle", 2]], random) : weighted(TRAFFIC_MIX, random);
          const car = new Car(x, y, z, model, Math.floor(random() * CAR_COLORS.length));
          car.yaw = car.prevYaw = yaw;
          g.spawn(car);
        }
      }
    }
  }
}

/** Dollars a player starts Neon Bay with. */
export const NEON_BAY_STAKE = 500;

/**
 * Neon Bay, free roam: the whole city, a car of your own outside your
 * crib, and five hundred dollars. Take any car you like — the one you are
 * standing next to, or the one somebody is driving.
 */
class NeonBayRuntime extends CityRuntime {
  private get given(): string[] { return ((this.data.given as string[] | undefined) ??= []); }
  private count(key: string, by = 1): void { this.data[key] = ((this.data[key] as number | undefined) ?? 0) + by; }

  start(): void {
    this.title(null, "Neon Bay", "Sun, sand, and questionable decisions.");
    this.tell(null, "Your ride is parked outside your crib. Use a car to get in, sneak to get out; W and S for the pedals, A and D to steer, Space for the handbrake. Any car is your car if you want it badly enough.", "#ff9ad8");
    const city = this.city();
    const home = city?.landmark("safehouse");
    const spot = home?.parking[0];
    if (spot) {
      const car = new Car(spot[0], spot[1], spot[2], "muscle", 14);
      car.yaw = car.prevYaw = spot[3];
      car.ambient = false;
      this.game.spawn(car);
    }
  }

  second(): void {
    for (const p of this.players()) {
      if (this.given.includes(p.name)) continue;
      this.given.push(p.name);
      this.giveCash(p.id, NEON_BAY_STAKE);
    }
  }

  onCarjack(): void { this.count("jacked"); }
  onKill(_killer: string, kind: string): void { if (kind === "citizen") this.count("bonked"); }
  onCarWrecked(): void { this.count("wrecked"); }

  objective(): Objective {
    const n = (k: string) => String((this.data[k] as number | undefined) ?? 0);
    return { title: "Neon Bay", lines: [["Cars jacked", n("jacked")], ["Cars wrecked", n("wrecked")], ["People bonked", n("bonked")]] };
  }

  restart(): string {
    this.data.given = [];
    this.data.jacked = this.data.wrecked = this.data.bonked = 0;
    return "The counters are back at zero, and everyone gets their five hundred again.";
  }
}

registerRuntime("neon_bay", (g, d, s) => new NeonBayRuntime(g, d, s));
