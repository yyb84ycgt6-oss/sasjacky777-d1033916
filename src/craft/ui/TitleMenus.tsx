/**
 * Everything before a world is running: the title screen, the world list,
 * world creation and joining a friend.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { randomSeed, seedFromString } from "../engine/rng";
import type { GameMode } from "../engine/player";
import type { WorldType } from "../engine/worldgen";
import { newWorldMeta, type SaveStore, type WorldMeta } from "../game/save";
import { effectiveControls, type Settings } from "../game/settings";
import { normalizeRoomCode } from "../net/transport";
import { Button, Cycle, Toggle } from "./common";
import { MenuFrame } from "./Menus";
import { textureBackground } from "./icons";

// Original lines; the yellow splash is part of the genre's charm.
const SPLASHES = [
  "Now with Jackie!", "Every texture painted by code!", "Plays on your phone!", "Open to friends!", "Saves itself!",
  "Twenty ticks a second!", "Punch a tree!", "Chunks all the way down!", "Mind the creepers!", "Built in SAS-JACKY!",
  "Sheep come in sixteen colours!", "Try hardcore!", "Beds skip the night!", "Water finds its level!", "Also try the Eru lab!",
  "Bone meal works!", "Real caves!", "Diamonds below 16!", "Creative mode flies!", "No downloads!",
];

/** The tiled dirt of every menu that is not over a world. */
export function MenuBackground() {
  const url = useMemo(() => textureBackground("dirt", 0.62), []);
  return <div className="absolute inset-0" style={{ backgroundImage: `url(${url})`, backgroundSize: "calc(var(--u) * 32)", imageRendering: "pixelated" }} />;
}

export function Logo() {
  const stone = useMemo(() => textureBackground("stone", 0), []);
  const splash = useMemo(() => SPLASHES[Math.floor(Math.random() * SPLASHES.length)], []);
  return (
    <div style={{ position: "relative", textAlign: "center", marginBottom: "calc(var(--u) * 10)" }}>
      <div
        aria-label="BlockCraft"
        style={{
          fontSize: "min(calc(var(--u) * 30), 13vw)", fontWeight: 900, letterSpacing: "0.05em", lineHeight: 1,
          backgroundImage: `url(${stone})`, backgroundSize: "calc(var(--u) * 12)", imageRendering: "pixelated",
          WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
          WebkitTextStroke: "calc(var(--u) * 0.8) #1b1b1b",
          filter: "drop-shadow(calc(var(--u) * 1.5) calc(var(--u) * 1.5) 0 #000)",
        }}
      >
        BLOCKCRAFT
      </div>
      <div className="bc-sub" style={{ marginTop: "calc(var(--u) * 2)", color: "#ddd" }}>BROWSER EDITION</div>
      <div
        style={{
          position: "absolute", right: "-2%", bottom: "calc(var(--u) * -4)", color: "#ffff00", fontSize: "calc(var(--u) * 7.5)",
          transform: "rotate(-18deg)", animation: "bc-pulse 0.5s ease-in-out infinite", whiteSpace: "nowrap",
          textShadow: "calc(var(--u) * 0.7) calc(var(--u) * 0.7) 0 #3f3f00",
        }}
      >
        {splash}
      </div>
    </div>
  );
}

export function TitleScreen({ onSingle, onMulti, onOptions, onExit, message, settings }: {
  onSingle: () => void; onMulti: () => void; onOptions: () => void; onExit: () => void; message?: string; settings: Settings;
}) {
  return (
    <>
      <MenuBackground />
      <div className="absolute inset-0 flex flex-col items-center justify-center bc-shadow" style={{ padding: "calc(var(--u) * 8)" }}>
        <Logo />
        {message && (
          <div style={{ maxWidth: "calc(var(--u) * 240)", marginBottom: "calc(var(--u) * 6)", textAlign: "center", color: "#ffcc55", fontSize: "calc(var(--u) * 6.5)", lineHeight: 1.5 }}>{message}</div>
        )}
        <div style={{ width: "min(100%, calc(var(--u) * 200))", display: "flex", flexDirection: "column", gap: "calc(var(--u) * 4)" }}>
          <Button wide onClick={onSingle}>Singleplayer</Button>
          <Button wide onClick={onMulti}>Multiplayer</Button>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "calc(var(--u) * 4)" }}>
            <Button onClick={onOptions}>Options…</Button>
            <Button onClick={onExit}>Back to Jackie</Button>
          </div>
        </div>
      </div>
      <div className="absolute bc-shadow" style={{ left: "calc(var(--u) * 2)", bottom: "calc(var(--u) * 2)", fontSize: "calc(var(--u) * 5.5)", color: "#ddd" }}>
        BlockCraft 1.0 · {effectiveControls(settings) === "mobile" ? "touch controls" : "keyboard & mouse"}
      </div>
      <div className="absolute bc-shadow" style={{ right: "calc(var(--u) * 2)", bottom: "calc(var(--u) * 2)", fontSize: "calc(var(--u) * 5.5)", color: "#ddd", textAlign: "right", maxWidth: "60%" }}>
        An original game inspired by Minecraft. Not affiliated with Mojang or Microsoft.
      </div>
    </>
  );
}

const MODE_LABEL: Record<string, string> = { survival: "Survival", creative: "Creative", adventure: "Adventure", spectator: "Spectator" };

function when(t: number): string {
  const d = new Date(t);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function WorldSelect({ saves, ready, onPlay, onCreate, onBack }: {
  saves: SaveStore; ready: Promise<void>; onPlay: (meta: WorldMeta) => void; onCreate: () => void; onBack: () => void;
}) {
  const [worlds, setWorlds] = useState<WorldMeta[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = async () => {
    try {
      // A world that was just quit may still be writing its last save.
      await ready.catch(() => {});
      const list = await saves.listWorlds();
      setWorlds(list);
      setSelected((s) => (s && list.some((w) => w.id === s) ? s : list[0]?.id ?? null));
    } catch (err) {
      setWorlds([]);
      setError(`Could not read your saved worlds: ${(err as Error).message}`);
    }
  };
  // Again when `ready` changes: the world just quit hands over its final save after this list mounts.
  useEffect(() => { void reload(); }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const sel = worlds?.find((w) => w.id === selected) ?? null;
  const shown = (worlds ?? []).filter((w) => !filter || w.name.toLowerCase().includes(filter.toLowerCase()));

  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(`${what}: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const exportWorld = (w: WorldMeta) => run("Export failed", async () => {
    const blob = await saves.exportWorld(w.id);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${w.name.replace(/[^\w\- ]/g, "").trim() || "world"}.blockcraft.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  const importWorld = (file: File) => run("Import failed", async () => {
    const meta = await saves.importWorld(await file.text());
    await reload();
    setSelected(meta.id);
  });

  const rename = (w: WorldMeta, name: string) => run("Rename failed", async () => {
    const clean = name.trim().slice(0, 32);
    if (!clean) return;
    await saves.putWorld({ ...w, name: clean });
    setRenaming(null);
    await reload();
  });

  const remove = (w: WorldMeta) => run("Delete failed", async () => {
    await saves.deleteWorld(w.id);
    setConfirmDelete(false);
    await reload();
  });

  if (confirmDelete && sel) {
    return (
      <>
        <MenuBackground />
        <MenuFrame title="Delete this world?" dim={false}>
          <div style={{ textAlign: "center", fontSize: "calc(var(--u) * 7)", lineHeight: 1.6 }}>
            '{sel.name}' will be lost forever — a long time! Export it first if you might want it back.
          </div>
          <Button wide danger disabled={busy} onClick={() => void remove(sel)}>Delete</Button>
          <Button wide onClick={() => setConfirmDelete(false)}>Cancel</Button>
        </MenuFrame>
      </>
    );
  }

  return (
    <>
      <MenuBackground />
      <div className="absolute inset-0 flex flex-col bc-shadow" style={{ padding: "calc(var(--u) * 4)" }}>
        <div className="bc-title" style={{ textAlign: "center", marginBottom: "calc(var(--u) * 4)" }}>Select World</div>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: "calc(var(--u) * 4)" }}>
          <input className="bc-input" style={{ maxWidth: "calc(var(--u) * 220)" }} placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="bc-scroll" style={{ flex: 1, background: "rgba(0,0,0,0.5)", borderTop: "calc(var(--u) * 1) solid #000", borderBottom: "calc(var(--u) * 1) solid #000", padding: "calc(var(--u) * 3) 0" }}>
          <div style={{ width: "min(100%, calc(var(--u) * 240))", margin: "0 auto", display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
            {worlds === null && <div className="bc-sub" style={{ textAlign: "center" }}>Loading worlds…</div>}
            {worlds?.length === 0 && (
              <div style={{ textAlign: "center", padding: "calc(var(--u) * 10)", fontSize: "calc(var(--u) * 7)", lineHeight: 1.6 }}>
                No worlds yet. Create one, or import a world you exported before.
              </div>
            )}
            {shown.map((w) => (
              <div
                key={w.id}
                className={`bc-list-item ${w.id === selected ? "sel" : ""}`}
                onClick={() => setSelected(w.id)}
                onDoubleClick={() => onPlay(w)}
              >
                <div style={{ width: "calc(var(--u) * 48)", height: "calc(var(--u) * 27)", flex: "none", background: "#222", border: "calc(var(--u) * 0.5) solid #555", overflow: "hidden" }}>
                  {w.thumbnail
                    ? <img src={w.thumbnail} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    : <div style={{ width: "100%", height: "100%", backgroundImage: `url(${textureBackground("grass_block_side", 0)})`, backgroundSize: "calc(var(--u) * 27)", imageRendering: "pixelated" }} />}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {renaming === w.id ? (
                    <input
                      className="bc-input" autoFocus defaultValue={w.name} maxLength={32}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void rename(w, (e.target as HTMLInputElement).value);
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(e) => void rename(w, e.target.value)}
                    />
                  ) : (
                    <div style={{ fontSize: "calc(var(--u) * 7.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</div>
                  )}
                  <div className="bc-sub">{when(w.lastPlayed)}</div>
                  <div className="bc-sub" style={{ color: w.hardcore ? "#ff5555" : undefined }}>
                    {w.hardcore ? "Hardcore Mode!" : `${MODE_LABEL[w.gameMode] ?? w.gameMode} Mode`}{w.cheats ? ", Cheats" : ""} · Day {Math.floor(w.time / 24000) + 1}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {(error || saves.problem) && (
          <div style={{ textAlign: "center", color: "#ff8080", fontSize: "calc(var(--u) * 6)", margin: "calc(var(--u) * 3) auto 0", maxWidth: "calc(var(--u) * 260)" }}>{error ?? saves.problem}</div>
        )}
        <div style={{ width: "min(100%, calc(var(--u) * 310))", margin: "calc(var(--u) * 4) auto 0", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(calc(var(--u) * 72), 1fr))", gap: "calc(var(--u) * 3)" }}>
          <Button disabled={!sel || busy} onClick={() => sel && onPlay(sel)}>Play Selected World</Button>
          <Button disabled={busy} onClick={onCreate}>Create New World</Button>
          <Button disabled={!sel || busy} onClick={() => sel && setRenaming(sel.id)}>Rename</Button>
          <Button disabled={!sel || busy} onClick={() => setConfirmDelete(true)}>Delete</Button>
          <Button disabled={!sel || busy} onClick={() => sel && void exportWorld(sel)}>Export…</Button>
          <Button disabled={busy} onClick={() => fileRef.current?.click()}>Import…</Button>
          <Button onClick={onBack}>Cancel</Button>
        </div>
        <input
          ref={fileRef} type="file" accept=".json,application/json" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importWorld(f); }}
        />
      </div>
    </>
  );
}

type ModeChoice = "survival" | "creative" | "hardcore";
const WORLD_TYPES: WorldType[] = ["default", "amplified", "large_biomes", "flat"];
const TYPE_LABEL: Record<WorldType, string> = { default: "Default", amplified: "Amplified", large_biomes: "Large Biomes", flat: "Superflat" };
const DIFFICULTY_LABEL = ["Peaceful", "Easy", "Normal", "Hard"];

export function CreateWorld({ saves, existing, onCreate, onBack }: {
  saves: SaveStore; existing: string[]; onCreate: (meta: WorldMeta) => void; onBack: () => void;
}) {
  const [name, setName] = useState(() => uniqueName("New World", existing));
  const [mode, setMode] = useState<ModeChoice>("survival");
  const [difficulty, setDifficulty] = useState<0 | 1 | 2 | 3>(2);
  const [type, setType] = useState<WorldType>("default");
  const [seedText, setSeedText] = useState("");
  const [cheats, setCheats] = useState(false);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hardcore = mode === "hardcore";
  const describe = {
    survival: "Search for resources, craft, gain levels, health and hunger",
    creative: "Unlimited resources, free flying and destroy blocks instantly",
    hardcore: "Same as survival mode, locked at hardest difficulty, and one life only",
  }[mode];

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const text = seedText.trim();
      const seed = !text ? randomSeed() : /^-?\d+$/.test(text) ? Number(BigInt.asIntN(32, BigInt(text))) : seedFromString(text);
      const gameMode: GameMode = mode === "creative" ? "creative" : "survival";
      const meta = newWorldMeta({
        name: name.trim().slice(0, 32) || "New World",
        seed, seedText: text || String(seed), type, gameMode,
        difficulty: hardcore ? 3 : difficulty, hardcore, cheats: hardcore ? false : cheats,
      });
      await saves.putWorld(meta);
      onCreate(meta);
    } catch (err) {
      setError(`Could not create the world: ${(err as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <>
      <MenuBackground />
      <MenuFrame title="Create New World" width={220} dim={false}>
        <label style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
          <span className="bc-sub">World Name</span>
          <input className="bc-input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} />
        </label>
        <Cycle<ModeChoice>
          label="Game Mode" value={mode} options={["survival", "creative", "hardcore"]}
          onChange={(v) => { setMode(v); setCheats(v === "creative"); }}
          format={(v) => v[0].toUpperCase() + v.slice(1)}
        />
        <div className="bc-sub" style={{ textAlign: "center", lineHeight: 1.5 }}>{describe}</div>
        {!hardcore && (
          <Cycle<number> label="Difficulty" value={difficulty} options={[0, 1, 2, 3]} onChange={(v) => setDifficulty(v as 0 | 1 | 2 | 3)} format={(v) => DIFFICULTY_LABEL[v]} />
        )}
        {!hardcore && <Toggle label="Allow Cheats" value={cheats} onChange={setCheats} />}
        <Button wide onClick={() => setMore(!more)}>{more ? "Fewer World Options" : "More World Options…"}</Button>
        {more && (
          <>
            <label style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
              <span className="bc-sub">Seed for the world generator (leave blank for a random seed)</span>
              <input className="bc-input" value={seedText} maxLength={48} onChange={(e) => setSeedText(e.target.value)} />
            </label>
            <Cycle<WorldType> label="World Type" value={type} options={WORLD_TYPES} onChange={setType} format={(v) => TYPE_LABEL[v]} />
          </>
        )}
        {error && <div style={{ color: "#ff8080", fontSize: "calc(var(--u) * 6)", textAlign: "center" }}>{error}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "calc(var(--u) * 4)" }}>
          <Button disabled={busy} onClick={() => void create()}>Create New World</Button>
          <Button onClick={onBack}>Cancel</Button>
        </div>
      </MenuFrame>
    </>
  );
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base} (${i})`)) return `${base} (${i})`;
}

export function MultiplayerScreen({ settings, onSettings, onJoin, onBack, busy, error }: {
  settings: Settings; onSettings: (s: Settings) => void; onJoin: (kind: "online" | "device", room: string) => void;
  onBack: () => void; busy: boolean; error: string | null;
}) {
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"online" | "device">("online");
  const room = normalizeRoomCode(code);
  return (
    <>
      <MenuBackground />
      <MenuFrame title="Play Multiplayer" width={230} dim={false}>
        <div className="bc-sub" style={{ textAlign: "center", lineHeight: 1.6 }}>
          A friend opens their world from the game menu (Esc → Open to friends) and reads you the code it shows.
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
          <span className="bc-sub">World code</span>
          <input
            className="bc-input" value={code} placeholder="e.g. K7QM3X" maxLength={16} autoCapitalize="characters" autoComplete="off"
            style={{ letterSpacing: "0.2em", textTransform: "uppercase" }}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && room.length >= 4 && !busy) onJoin(kind, room); }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
          <span className="bc-sub">Your name</span>
          <input
            className="bc-input" value={settings.playerName} maxLength={16} placeholder="Steve"
            onChange={(e) => onSettings({ ...settings, playerName: e.target.value.replace(/[^\w\- ]/g, "").slice(0, 16) })}
          />
        </label>
        <Cycle<"online" | "device">
          label="Connect" value={kind} options={["online", "device"]} onChange={setKind}
          format={(v) => (v === "online" ? "Online (any device)" : "Tabs on this device")}
        />
        {error && <div style={{ color: "#ff8080", fontSize: "calc(var(--u) * 6)", textAlign: "center", lineHeight: 1.5 }}>{error}</div>}
        <Button wide disabled={busy || room.length < 4} onClick={() => onJoin(kind, room)}>{busy ? "Joining…" : "Join World"}</Button>
        <Button wide onClick={onBack}>Back</Button>
      </MenuFrame>
    </>
  );
}
