/**
 * BlockCraft, start to finish: title → worlds → a running world, or title →
 * multiplayer → a friend's world. Mounted full-screen over the app; leaving
 * saves whatever is running.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Role } from "../game/game";
import { SaveStore, type WorldMeta } from "../game/save";
import { loadSettings, saveSettings, type Settings } from "../game/settings";
import { NetSession, type Welcome } from "../net/session";
import { guiUnit } from "./common";
import { GameView } from "./GameView";
import { OptionsScreen } from "./Menus";
import { THEME_CSS } from "./theme";
import { CreateWorld, MenuBackground, MultiplayerScreen, TitleScreen, WorldSelect } from "./TitleMenus";

type View =
  | { kind: "title"; message?: string }
  | { kind: "worlds" }
  | { kind: "create"; existing: string[] }
  | { kind: "multiplayer" }
  | { kind: "options" }
  | { kind: "game"; meta: WorldMeta; role: Role; session: NetSession | null; run: number };

/** A world the guest does not own: only what the host chose to share, never written to this browser's saves. */
function guestWorld(w: Welcome, room: string): WorldMeta {
  const now = Date.now();
  return {
    id: `guest:${room}`,
    name: w.worldName,
    seed: w.seed,
    seedText: w.seedText,
    type: w.type,
    gameMode: w.player?.gameMode ?? w.gameMode,
    difficulty: w.difficulty,
    hardcore: w.hardcore,
    cheats: w.cheats,
    created: now,
    lastPlayed: now,
    playTime: 0,
    time: w.time,
    day: 0,
    // The host runs the weather; a guest's timers never fire.
    weather: { rain: w.rain, thunder: w.thunder, rainTimer: Number.MAX_SAFE_INTEGER, thunderTimer: Number.MAX_SAFE_INTEGER },
    spawn: w.spawn,
    rules: w.rules,
    player: w.player,
    players: {},
    entities: [],
    dimension: w.dimension,
    version: 1,
  };
}

export function CraftApp({ onExit }: { onExit: () => void }) {
  const saves = useMemo(() => new SaveStore(), []);
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const [view, setView] = useState<View>({ kind: "title" });
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [join, setJoin] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const runs = useRef(0);
  // The last world's final save; the world list waits on it so it never shows stale data.
  const [lastSave, setLastSave] = useState<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
  }, []);

  const setSettings = (s: Settings) => {
    setSettingsState(s);
    saveSettings(s);
  };

  const play = (meta: WorldMeta, role: Role, session: NetSession | null) => {
    setView({ kind: "game", meta, role, session, run: ++runs.current });
  };

  const joinWorld = async (kind: "online" | "device", room: string) => {
    setJoin({ busy: true, error: null });
    try {
      const { session, welcome } = await NetSession.join(kind, room, settings.playerName.trim() || "Player", settings.skin);
      setJoin({ busy: false, error: null });
      play(guestWorld(welcome, room), "guest", session);
    } catch (err) {
      setJoin({ busy: false, error: (err as Error).message });
    }
  };

  const u = guiUnit(settings.guiScale, size.w, size.h);
  const style = { "--u": `${u}px` } as CSSProperties;

  return (
    <div className="bc-root" style={style}>
      <style>{THEME_CSS}</style>
      {view.kind === "title" && (
        <TitleScreen
          settings={settings}
          message={view.message ?? saves.problem ?? undefined}
          onSingle={() => setView({ kind: "worlds" })}
          onMulti={() => { setJoin({ busy: false, error: null }); setView({ kind: "multiplayer" }); }}
          onOptions={() => setView({ kind: "options" })}
          onExit={onExit}
        />
      )}
      {view.kind === "worlds" && (
        <WorldSelect
          saves={saves}
          ready={lastSave}
          onPlay={(meta) => play(meta, "local", null)}
          onCreate={() => void saves.listWorlds().then((l) => setView({ kind: "create", existing: l.map((w) => w.name) }), () => setView({ kind: "create", existing: [] }))}
          onBack={() => setView({ kind: "title" })}
        />
      )}
      {view.kind === "create" && (
        <CreateWorld
          saves={saves}
          existing={view.existing}
          onCreate={(meta) => play(meta, "local", null)}
          onBack={() => setView({ kind: "worlds" })}
        />
      )}
      {view.kind === "multiplayer" && (
        <MultiplayerScreen
          settings={settings}
          onSettings={setSettings}
          busy={join.busy}
          error={join.error}
          onJoin={(kind, room) => void joinWorld(kind, room)}
          onBack={() => setView({ kind: "title" })}
        />
      )}
      {view.kind === "options" && (
        <>
          <MenuBackground />
          <OptionsScreen settings={settings} onChange={setSettings} onDone={() => setView({ kind: "title" })} inGame={false} />
        </>
      )}
      {view.kind === "game" && (
        <GameView
          key={view.run}
          meta={view.meta}
          role={view.role}
          session={view.session}
          saves={saves}
          settings={settings}
          onSettings={setSettings}
          onStopped={(p) => setLastSave(p)}
          onQuit={(message) => setView(view.role === "guest" ? { kind: "title", message } : message ? { kind: "title", message } : { kind: "worlds" })}
          onExitApp={onExit}
        />
      )}
    </div>
  );
}
