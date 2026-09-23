import { useMemo, useState, type ReactNode } from "react";
import { allRecipes, canAfford, recipeResult, type Recipe } from "../engine/crafting";
import { allItems, itemDef, type Category } from "../engine/items";
import { B } from "../engine/blocks";
import type { Slot } from "../engine/inventory";
import type { Game } from "../game/game";
import {
  chestView, clickContainer, craftOutput, craftWidth, creativeTake, creativeTrash, dropCursor, fillRecipe, furnaceView,
  inventoryCounts, type Section,
} from "../game/containers";
import { boxRegions, skin } from "../render/skins";
import { Button, CursorStack, ItemIcon, SlotButton, useTooltip } from "./common";

function Grid({ slots, cols, section, game, offset = 0, onHover, quick }: {
  slots: Slot[]; cols: number; section: Section; game: Game; offset?: number; onHover: (s: Slot, x: number, y: number) => void; quick: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, var(--slot))` }}>
      {slots.map((s, i) => (
        <SlotButton key={i} stack={s} onHover={onHover} quickMove={quick}
          onClick={(b, shift) => clickContainer(game, section, i + offset, b, shift)} />
      ))}
    </div>
  );
}

function PlayerSlots({ game, onHover, quick }: { game: Game; onHover: (s: Slot, x: number, y: number) => void; quick: boolean }) {
  const inv = game.player.inventory;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 4)" }}>
      <Grid slots={inv.slots.slice(9, 36)} cols={9} section="inv" offset={9} game={game} onHover={onHover} quick={quick} />
      <Grid slots={inv.slots.slice(0, 9)} cols={9} section="inv" offset={0} game={game} onHover={onHover} quick={quick} />
    </div>
  );
}

/** The shared frame: a centred panel, a click-outside-to-drop backdrop, tooltip and cursor stack. */
function Frame({ game, title, children, side, mobile, quick, setQuick }: {
  game: Game; title: string; children: ReactNode; side?: ReactNode; mobile: boolean; quick: boolean; setQuick: (v: boolean) => void;
}) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-auto"
      onMouseDown={(e) => { if (e.target === e.currentTarget) dropCursor(game, e.button === 2); }}
      onContextMenu={(e) => e.preventDefault()}>
      <div className="bc-dim" style={{ pointerEvents: "none" }} />
      <div style={{ position: "relative", display: "flex", gap: "calc(var(--u) * 3)", alignItems: "flex-start", maxHeight: "100%" }}>
        {side}
        <div className="bc-panel" style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 4)" }}>
          <div className="bc-label" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "calc(var(--u) * 4)" }}>
            <span>{title}</span>
            <span style={{ display: "flex", gap: "calc(var(--u) * 2)" }}>
              {mobile && (
                <button type="button" className="bc-btn" style={{ minHeight: "calc(var(--u) * 12)", fontSize: "calc(var(--u) * 5.5)", background: quick ? "#5c6ea8" : undefined }}
                  onClick={() => setQuick(!quick)}>⇅ Quick move</button>
              )}
              <button type="button" className="bc-btn" style={{ minHeight: "calc(var(--u) * 12)", fontSize: "calc(var(--u) * 6)" }} onClick={() => game.setScreen(null)} aria-label="Close">✕</button>
            </span>
          </div>
          {children}
        </div>
      </div>
      <CursorStack stack={game.cursor} />
    </div>
  );
}

function Arrow({ progress = 0 }: { progress?: number }) {
  return (
    <div style={{ position: "relative", width: "calc(var(--u) * 22)", height: "calc(var(--u) * 15)", display: "flex", alignItems: "center" }}>
      <div style={{ fontSize: "calc(var(--u) * 14)", color: "#8b8b8b", lineHeight: 1 }}>➜</div>
      {progress > 0 && (
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${progress * 100}%`, overflow: "hidden", display: "flex", alignItems: "center" }}>
          <div style={{ fontSize: "calc(var(--u) * 14)", color: "#fff", lineHeight: 1 }}>➜</div>
        </div>
      )}
    </div>
  );
}

function CraftingArea({ game, onHover, quick }: { game: Game; onHover: (s: Slot, x: number, y: number) => void; quick: boolean }) {
  const width = craftWidth(game);
  const out = craftOutput(game);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "calc(var(--u) * 4)" }}>
      <Grid slots={game.craftGrid} cols={width} section="grid" game={game} onHover={onHover} quick={quick} />
      <Arrow />
      <SlotButton stack={out?.stack ?? null} className="bc-result" onHover={onHover} quickMove={quick}
        onClick={(b, shift) => clickContainer(game, "result", 0, b, shift)} />
    </div>
  );
}

function RecipeBook({ game, open }: { game: Game; open: boolean }) {
  const [onlyCraftable, setOnly] = useState(true);
  const [search, setSearch] = useState("");
  const width = craftWidth(game);
  const counts = inventoryCounts(game);
  const list = useMemo(() => {
    const seen = new Set<string>();
    return allRecipes().filter((r) => {
      if (width === 2 && !r.small) return false;
      const key = r.result.item;
      if (seen.has(key + r.id)) return false;
      seen.add(key + r.id);
      return true;
    });
  }, [width]);
  if (!open) return null;
  const q = search.trim().toLowerCase();
  const shown = list.filter((r) => (!q || itemDef(recipeResult(r).id)?.displayName.toLowerCase().includes(q)) && (!onlyCraftable || canAfford(r, counts)));
  return (
    <div className="bc-panel" style={{ width: "calc(var(--u) * 116)", display: "flex", flexDirection: "column", gap: "calc(var(--u) * 3)", maxHeight: "calc(var(--u) * 180)" }}>
      <div className="bc-label">Recipe book</div>
      <input className="bc-input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ minHeight: "calc(var(--u) * 13)" }} />
      <button type="button" className="bc-btn" style={{ minHeight: "calc(var(--u) * 12)", fontSize: "calc(var(--u) * 5.5)" }} onClick={() => setOnly(!onlyCraftable)}>
        {onlyCraftable ? "Showing craftable" : "Showing all"}
      </button>
      <div className="bc-scroll" style={{ display: "grid", gridTemplateColumns: "repeat(5, var(--slot))", alignContent: "start", flex: 1, minHeight: 0 }}>
        {shown.map((r: Recipe) => {
          const res = recipeResult(r);
          const ok = canAfford(r, counts);
          return (
            <div key={r.id} className="bc-slot" title={itemDef(res.id)?.displayName}
              style={{ background: ok ? "#8bb88b" : "#b88b8b" }}
              onClick={(e) => { if (ok) fillRecipe(game, r, e.shiftKey); }}
              onContextMenu={(e) => { e.preventDefault(); if (ok) fillRecipe(game, r, true); }}>
              <ItemIcon id={res.id} />
              {res.count > 1 && <span className="bc-count">{res.count}</span>}
            </div>
          );
        })}
        {!shown.length && <div className="bc-label" style={{ gridColumn: "1 / -1", fontSize: "calc(var(--u) * 5.5)" }}>{onlyCraftable ? "Nothing craftable yet — gather more materials." : "No recipes match."}</div>}
      </div>
    </div>
  );
}

const TABS: { id: Category | "search" | "survival"; label: string; icon: string }[] = [
  { id: "building", label: "Building Blocks", icon: "bricks" },
  { id: "colored", label: "Colored Blocks", icon: "cyan_wool" },
  { id: "natural", label: "Natural Blocks", icon: "grass_block" },
  { id: "functional", label: "Functional Blocks", icon: "crafting_table" },
  { id: "redstone", label: "Redstone Blocks", icon: "redstone" },
  { id: "tools", label: "Tools & Utilities", icon: "iron_pickaxe" },
  { id: "combat", label: "Combat", icon: "diamond_sword" },
  { id: "food", label: "Food & Drinks", icon: "cooked_beef" },
  { id: "ingredients", label: "Ingredients", icon: "iron_ingot" },
  { id: "search", label: "Search", icon: "compass" },
  { id: "survival", label: "Survival Inventory", icon: "chest" },
];

function CreativeInventory({ game, onHover, mobile }: { game: Game; onHover: (s: Slot, x: number, y: number) => void; mobile: boolean }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("building");
  const [search, setSearch] = useState("");
  const [quick, setQuick] = useState(false);
  const inv = game.player.inventory;
  const items = useMemo(() => {
    const all = allItems().filter((i) => !i.hidden);
    if (tab === "search") {
      const q = search.trim().toLowerCase();
      return all.filter((i) => !q || i.displayName.toLowerCase().includes(q) || i.name.includes(q));
    }
    return all.filter((i) => i.category === tab);
  }, [tab, search]);
  const tabIcon = (name: string) => {
    const def = allItems().find((i) => i.name === name);
    return def ? <ItemIcon id={def.id} /> : <span style={{ fontSize: "calc(var(--u) * 9)" }}>🔍</span>;
  };
  return (
    <Frame game={game} title={TABS.find((t) => t.id === tab)?.label ?? ""} mobile={mobile} quick={quick} setQuick={setQuick}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "calc(var(--u) * 1)", maxWidth: "calc(var(--slot) * 9)" }}>
        {TABS.map((t) => (
          <button key={t.id} type="button" title={t.label} className="bc-slot" onClick={() => setTab(t.id)}
            style={{ background: tab === t.id ? "#c6c6c6" : "#8b8b8b" }}>{tabIcon(t.icon)}</button>
        ))}
      </div>
      {tab === "survival" ? (
        <SurvivalBody game={game} onHover={onHover} quick={quick} creative />
      ) : (
        <>
          {tab === "search" && <input autoFocus={!mobile} className="bc-input" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} />}
          <div className="bc-scroll" style={{ display: "grid", gridTemplateColumns: "repeat(9, var(--slot))", maxHeight: "calc(var(--slot) * 5)", alignContent: "start" }}>
            {items.map((d) => (
              <SlotButton key={d.id} stack={{ id: d.id, count: 1 }} onHover={onHover}
                onClick={(b, shift) => creativeTake(game, d.id, b, shift || quick)} />
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "calc(var(--u) * 3)" }}>
            <Grid slots={inv.slots.slice(0, 9)} cols={9} section="inv" game={game} onHover={onHover} quick={false} />
            <div className="bc-slot" title="Destroy item" onClick={() => creativeTrash(game)} style={{ background: "#b85c5c" }}>🗑</div>
          </div>
        </>
      )}
    </Frame>
  );
}

/** The player's own skin, front on — the flat cousin of the turning model in the original's inventory. */
function PlayerPreview({ variant }: { variant: number }) {
  const url = useMemo(() => {
    const src = skin("player", variant);
    const c = document.createElement("canvas");
    c.width = 16; c.height = 32;
    const g = c.getContext("2d");
    if (!g) return null;
    const head = boxRegions(0, 0, 8, 8, 8).front, body = boxRegions(16, 16, 8, 12, 4).front;
    const arm = boxRegions(40, 16, 4, 12, 4).front, leg = boxRegions(0, 16, 4, 12, 4).front;
    const put = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, mirror = false) => {
      g.save();
      if (mirror) { g.translate(x + r.w, y); g.scale(-1, 1); g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h); }
      else g.drawImage(src, r.x, r.y, r.w, r.h, x, y, r.w, r.h);
      g.restore();
    };
    put(head, 4, 0); put(body, 4, 8); put(arm, 0, 8); put(arm, 12, 8, true); put(leg, 4, 20); put(leg, 8, 20, true);
    return c.toDataURL();
  }, [variant]);
  if (!url) return null;
  return <img src={url} alt="" style={{ height: "calc(var(--u) * 52)", imageRendering: "pixelated" }} draggable={false} />;
}

function SurvivalBody({ game, onHover, quick, creative }: { game: Game; onHover: (s: Slot, x: number, y: number) => void; quick: boolean; creative?: boolean }) {
  const inv = game.player.inventory;
  const ARMOR_GHOST = ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"].map((n) => allItems().find((i) => i.name === n)!.id);
  return (
    <>
      <div style={{ display: "flex", gap: "calc(var(--u) * 6)", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {inv.armor.map((s, i) => (
            <SlotButton key={i} stack={s} ghost={ARMOR_GHOST[i]} onHover={onHover} quickMove={quick}
              onClick={(b, shift) => clickContainer(game, "armor", i, b, shift)} />
          ))}
        </div>
        <div style={{ width: "calc(var(--u) * 44)", height: "calc(var(--slot) * 4)", background: "#000", border: "calc(var(--u) * 1) solid #373737", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: "calc(var(--u) * 2)", color: "#aaa", fontSize: "calc(var(--u) * 5)", padding: "calc(var(--u) * 2)" }}>
          <PlayerPreview variant={game.settings.skin} />
          {game.player.name}
        </div>
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "flex-end", alignSelf: "stretch" }}>
          <SlotButton stack={inv.offhand} onHover={onHover} onClick={(b, shift) => clickContainer(game, "offhand", 0, b, shift)} />
        </div>
        {!creative && (
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
            <div className="bc-label">Crafting</div>
            <CraftingArea game={game} onHover={onHover} quick={quick} />
          </div>
        )}
      </div>
      <PlayerSlots game={game} onHover={onHover} quick={quick} />
    </>
  );
}

export function InventoryScreen({ game, mobile }: { game: Game; mobile: boolean }) {
  const { tip, onHover } = useTooltip();
  const [book, setBook] = useState(mobile);
  const [quick, setQuick] = useState(false);
  if (game.player.gameMode === "creative") return <>{tip}<CreativeInventory game={game} onHover={onHover} mobile={mobile} /></>;
  return (
    <>
      <Frame game={game} title="Inventory" mobile={mobile} quick={quick} setQuick={setQuick} side={<RecipeBook game={game} open={book} />}>
        <SurvivalBody game={game} onHover={onHover} quick={quick} />
        <Button onClick={() => setBook(!book)}>📖 {book ? "Hide" : "Show"} recipe book</Button>
      </Frame>
      {tip}
    </>
  );
}

export function CraftingScreen({ game, mobile }: { game: Game; mobile: boolean }) {
  const { tip, onHover } = useTooltip();
  const [book, setBook] = useState(true);
  const [quick, setQuick] = useState(false);
  return (
    <>
      <Frame game={game} title="Crafting" mobile={mobile} quick={quick} setQuick={setQuick} side={<RecipeBook game={game} open={book} />}>
        <CraftingArea game={game} onHover={onHover} quick={quick} />
        <Button onClick={() => setBook(!book)}>📖 {book ? "Hide" : "Show"} recipe book</Button>
        <div className="bc-label">Inventory</div>
        <PlayerSlots game={game} onHover={onHover} quick={quick} />
      </Frame>
      {tip}
    </>
  );
}

export function FurnaceScreen({ game, mobile }: { game: Game; mobile: boolean }) {
  const { tip, onHover } = useTooltip();
  const [quick, setQuick] = useState(false);
  const f = furnaceView(game);
  if (!f) return null;
  const burn = f.burnTotal ? f.burn / f.burnTotal : 0;
  return (
    <>
      <Frame game={game} title="Furnace" mobile={mobile} quick={quick} setQuick={setQuick}>
        <div style={{ display: "flex", alignItems: "center", gap: "calc(var(--u) * 8)", justifyContent: "center" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "calc(var(--u) * 2)" }}>
            <SlotButton stack={f.input} onHover={onHover} quickMove={quick} onClick={(b, s) => clickContainer(game, "furnace", 0, b, s)} />
            <div style={{ width: "calc(var(--u) * 14)", height: "calc(var(--u) * 14)", position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              <div style={{ fontSize: "calc(var(--u) * 12)", lineHeight: 1, opacity: 0.25 }}>🔥</div>
              {burn > 0 && <div style={{ position: "absolute", bottom: 0, height: `${burn * 100}%`, overflow: "hidden", display: "flex", alignItems: "flex-end" }}><div style={{ fontSize: "calc(var(--u) * 12)", lineHeight: 1 }}>🔥</div></div>}
            </div>
            <SlotButton stack={f.fuel} onHover={onHover} quickMove={quick} onClick={(b, s) => clickContainer(game, "furnace", 1, b, s)} />
          </div>
          <Arrow progress={f.cook / 200} />
          <SlotButton stack={f.output} onHover={onHover} quickMove={quick} onClick={(b, s) => clickContainer(game, "furnace", 2, b, s)} />
        </div>
        <div className="bc-label">Inventory</div>
        <PlayerSlots game={game} onHover={onHover} quick={quick} />
      </Frame>
      {tip}
    </>
  );
}

export function ChestScreen({ game, mobile }: { game: Game; mobile: boolean }) {
  const { tip, onHover } = useTooltip();
  const [quick, setQuick] = useState(false);
  const chest = chestView(game);
  if (!chest) return null;
  const s = game.screen;
  const blockId = s && s.kind === "chest" ? game.world.blockAt(s.x, s.y, s.z) : B.CHEST;
  // The same screen serves chests (27), hoppers (a row of 5) and dispensers and droppers (3×3).
  const title = blockId === B.HOPPER ? "Item Hopper" : blockId === B.DISPENSER ? "Dispenser" : blockId === B.DROPPER ? "Dropper" : "Chest";
  const cols = chest.items.length === 9 ? 3 : chest.items.length === 5 ? 5 : 9;
  return (
    <>
      <Frame game={game} title={title} mobile={mobile} quick={quick} setQuick={setQuick}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Grid slots={chest.items} cols={cols} section="chest" game={game} onHover={onHover} quick={quick} />
        </div>
        <div className="bc-label">Inventory</div>
        <PlayerSlots game={game} onHover={onHover} quick={quick} />
      </Frame>
      {tip}
    </>
  );
}
