/**
 * Chat commands, the familiar set: /time, /gamemode, /give, /tp, /weather,
 * /kill, /seed, /spawnpoint, /difficulty, /gamerule, /clear, /summon,
 * /effect, /xp, /help.
 *
 * World-changing commands need cheats on (as a world option) or creative
 * mode, as in the original. An online guest can only run the ones that affect
 * nobody else — the host owns the world.
 */
import { DAY_TICKS } from "../engine/constants";
import { allItems, itemByName, type StatusEffect } from "../engine/items";
import { Mob, MOB_KINDS, type MobKind } from "../engine/mobs";
import type { GameMode } from "../engine/player";
import type { Game } from "./game";
import type { GameRules } from "./save";

interface Line { text: string; color?: string }

const ERR = "#ff6666";
const OK = "#aaaaaa";

const MODES: Record<string, GameMode> = {
  survival: "survival", s: "survival", "0": "survival",
  creative: "creative", c: "creative", "1": "creative",
  adventure: "adventure", a: "adventure", "2": "adventure",
  spectator: "spectator", sp: "spectator", "3": "spectator",
};

const HELP = [
  "/time set day|noon|night|midnight|<ticks>, /time add <ticks>",
  "/gamemode survival|creative|adventure|spectator",
  "/give <item> [count]   (e.g. /give diamond_pickaxe)",
  "/tp <x> <y> <z>, /tp spawn",
  "/weather clear|rain|thunder",
  "/summon <pig|cow|sheep|chicken|zombie|skeleton|creeper|spider>",
  "/effect <regeneration|speed|night_vision|...> [seconds] | /effect clear",
  "/xp add <amount>, /clear, /kill, /seed, /spawnpoint",
  "/difficulty peaceful|easy|normal|hard, /gamerule <rule> <true|false>",
];

export function runCommand(game: Game, line: string): Line[] {
  const [cmd, ...args] = line.trim().split(/\s+/);
  const p = game.player;
  const cheats = game.meta.cheats || p.gameMode === "creative";
  const guest = game.role === "guest";
  const needCheats = (): Line[] | null => (cheats ? null : [{ text: "Cheats are off in this world. Turn on \"Allow cheats\" when creating a world.", color: ERR }]);
  const needHost = (): Line[] | null => (guest ? [{ text: "Only the host can change the world online.", color: ERR }] : null);
  const num = (v: string | undefined, rel: number) => {
    if (v === undefined) return NaN;
    if (v.startsWith("~")) return rel + (v.length > 1 ? Number(v.slice(1)) : 0);
    return Number(v);
  };

  switch ((cmd ?? "").toLowerCase()) {
    case "help": case "?":
      return HELP.map((text) => ({ text, color: OK }));
    case "seed":
      return [{ text: `Seed: ${game.meta.seed}${game.meta.seedText && game.meta.seedText !== String(game.meta.seed) ? ` ("${game.meta.seedText}")` : ""}` }];
    case "time": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const named: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };
      const [op, value] = args;
      const day = Math.floor(game.time / DAY_TICKS) * DAY_TICKS;
      if (op === "set") {
        const t = named[value] ?? Number(value);
        if (!Number.isFinite(t)) return [{ text: "Usage: /time set day|noon|night|midnight|<ticks>", color: ERR }];
        game.time = day + (t % DAY_TICKS);
        return [{ text: `Set the time to ${t}` }];
      }
      if (op === "add") {
        const t = Number(value);
        if (!Number.isFinite(t)) return [{ text: "Usage: /time add <ticks>", color: ERR }];
        game.time += t;
        return [{ text: `Added ${t} to the time` }];
      }
      return [{ text: `The time is ${game.time % DAY_TICKS} (day ${Math.floor(game.time / DAY_TICKS)})` }];
    }
    case "gamemode": case "gm": {
      const denied = needCheats();
      if (denied) return denied;
      const mode = MODES[(args[0] ?? "").toLowerCase()];
      if (!mode) return [{ text: "Usage: /gamemode survival|creative|adventure|spectator", color: ERR }];
      p.setGameMode(mode);
      game.bumpInv();
      return [{ text: `Set own game mode to ${mode[0].toUpperCase()}${mode.slice(1)} Mode` }];
    }
    case "give": {
      const denied = needCheats();
      if (denied) return denied;
      const name = (args[0] ?? "").replace(/^minecraft:/, "").toLowerCase();
      let def;
      try { def = itemByName(name); } catch {
        const near = allItems().filter((i) => i.name.includes(name)).slice(0, 5).map((i) => i.name);
        return [{ text: `Unknown item "${name}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`, color: ERR }];
      }
      const count = Math.max(1, Math.min(64 * 36, Number(args[1] ?? 1) || 1));
      let left = count;
      while (left > 0) {
        const n = Math.min(left, def.maxStack);
        const rest = p.inventory.add({ id: def.id, count: n });
        if (rest > 0) { game.actions.throwStack({ id: def.id, count: rest }); }
        left -= n;
      }
      game.bumpInv();
      return [{ text: `Gave ${count} [${def.displayName}] to ${p.name}` }];
    }
    case "tp": case "teleport": {
      const denied = needCheats();
      if (denied) return denied;
      const b = p.body;
      if (args[0] === "spawn") {
        const s = game.worldSpawn();
        b.x = s.x; b.z = s.z; b.y = game.surfaceAt(s.x, s.z);
      } else {
        const x = num(args[0], b.x), y = num(args[1], b.y), z = num(args[2], b.z);
        if (![x, y, z].every(Number.isFinite)) return [{ text: "Usage: /tp <x> <y> <z> (~ for relative)", color: ERR }];
        b.x = x; b.y = y; b.z = z;
      }
      b.vx = b.vy = b.vz = 0;
      b.fallDistance = 0;
      p.prevX = b.x; p.prevY = b.y; p.prevZ = b.z;
      return [{ text: `Teleported ${p.name} to ${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}` }];
    }
    case "weather": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const w = game.meta.weather;
      const kind = args[0];
      if (kind === "clear") { w.rain = 0; w.thunder = 0; w.rainTimer = 12000 + Math.floor(Math.random() * 168000); }
      else if (kind === "rain") { w.rain = 1; w.thunder = 0; w.rainTimer = 12000 + Math.floor(Math.random() * 12000); }
      else if (kind === "thunder") { w.rain = 1; w.thunder = 1; w.rainTimer = 12000; w.thunderTimer = 12000; }
      else return [{ text: "Usage: /weather clear|rain|thunder", color: ERR }];
      return [{ text: `Set the weather to ${kind}` }];
    }
    case "kill":
      p.hurt(1000, "void");
      return [];
    case "clear": {
      const denied = needCheats();
      if (denied) return denied;
      p.inventory.clear();
      game.bumpInv();
      return [{ text: `Removed all items from ${p.name}` }];
    }
    case "spawnpoint": {
      const denied = needCheats();
      if (denied) return denied;
      const b = p.body;
      p.spawn = { x: Math.floor(b.x), y: Math.floor(b.y), z: Math.floor(b.z) };
      return [{ text: `Set spawn point to ${p.spawn.x}, ${p.spawn.y}, ${p.spawn.z}` }];
    }
    case "setworldspawn": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const b = p.body;
      game.meta.spawn = { x: Math.floor(b.x) + 0.5, y: Math.floor(b.y), z: Math.floor(b.z) + 0.5 };
      return [{ text: "Set the world spawn point" }];
    }
    case "difficulty": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const names = ["peaceful", "easy", "normal", "hard"];
      const d = names.indexOf((args[0] ?? "").toLowerCase());
      if (d < 0) return [{ text: `The difficulty is ${names[game.meta.difficulty]}` }];
      if (game.meta.hardcore) return [{ text: "Difficulty is locked to hard in hardcore worlds", color: ERR }];
      game.meta.difficulty = d as 0 | 1 | 2 | 3;
      return [{ text: `The difficulty has been set to ${names[d]}` }];
    }
    case "gamerule": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const rules = game.meta.rules;
      const key = args[0] as keyof GameRules;
      if (!key || !(key in rules)) return [{ text: `Game rules: ${Object.entries(rules).map(([k, v]) => `${k}=${v}`).join(", ")}` }];
      if (args[1] === undefined) return [{ text: `${key} = ${rules[key]}` }];
      if (args[1] !== "true" && args[1] !== "false") return [{ text: "Use true or false", color: ERR }];
      rules[key] = args[1] === "true";
      return [{ text: `Game rule ${key} is now set to ${args[1]}` }];
    }
    case "summon": {
      const denied = needCheats() ?? needHost();
      if (denied) return denied;
      const kind = (args[0] ?? "").replace(/^minecraft:/, "") as MobKind;
      if (!MOB_KINDS.includes(kind)) return [{ text: `Usage: /summon ${MOB_KINDS.join("|")}`, color: ERR }];
      const b = p.body;
      const d = 2;
      game.spawn(new Mob(kind, b.x - Math.sin(p.yaw) * d, b.y, b.z - Math.cos(p.yaw) * d));
      return [{ text: `Summoned new ${kind}` }];
    }
    case "effect": {
      const denied = needCheats();
      if (denied) return denied;
      if (args[0] === "clear") { p.effects = []; return [{ text: "Removed every effect" }]; }
      const kinds: StatusEffect[] = ["regeneration", "hunger", "poison", "absorption", "speed", "night_vision"];
      const kind = args[0] as StatusEffect;
      if (!kinds.includes(kind)) return [{ text: `Usage: /effect ${kinds.join("|")} [seconds] [level], or /effect clear`, color: ERR }];
      p.addEffect(kind, Math.max(1, Number(args[1] ?? 30) || 30), Math.max(0, (Number(args[2] ?? 1) || 1) - 1));
      return [{ text: `Applied ${kind} to ${p.name}` }];
    }
    case "xp": case "experience": {
      const denied = needCheats();
      if (denied) return denied;
      const amount = Number(args[1] ?? args[0]);
      if (!Number.isFinite(amount)) return [{ text: "Usage: /xp add <amount>", color: ERR }];
      if ((args[2] ?? "").startsWith("level")) p.xpLevel += amount;
      else game.addXp(amount);
      return [{ text: `Gave ${amount} experience to ${p.name}` }];
    }
    case "me":
      game.net?.chat(`* ${p.name} ${args.join(" ")}`);
      return [{ text: `* ${p.name} ${args.join(" ")}`, color: "#dddddd" }];
    default:
      return [{ text: `Unknown command "/${cmd}". Type /help for the list.`, color: ERR }];
  }
}
