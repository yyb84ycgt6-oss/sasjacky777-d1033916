import { useEffect, useState } from "react";
import type { Hud as HudState } from "../game/types";
import { glyph, textureBackground } from "./icons";
import { ItemIcon, StackView } from "./common";
import { clock, effectName } from "./itemText";
import { itemId } from "../engine/items";

function Row({ full, max, icon, half, empty, reverse, shake }: {
  full: number; max: number; icon: string; half: string; empty: string; reverse?: boolean; shake?: boolean;
}) {
  const cells = [];
  for (let i = 0; i < max / 2; i++) {
    const v = full - i * 2;
    const src = v >= 2 ? glyph(icon) : v === 1 ? glyph(half) : glyph(empty);
    const jitter = shake ? (Math.random() * 2 - 1) : 0;
    cells.push(<img key={i} src={src} className="bc-glyph" alt="" style={{ marginRight: "calc(var(--u) * -0)", transform: `translateY(calc(var(--u) * ${jitter}))` }} />);
  }
  return <div style={{ display: "flex", flexDirection: reverse ? "row-reverse" : "row" }}>{cells}</div>;
}

export function Hud({ hud, mobile, crosshair }: { hud: HudState; mobile: boolean; crosshair: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const now = performance.now();
  const survival = hud.gameMode === "survival" || hud.gameMode === "adventure";
  const hurtFlash = now - hud.hurtAt < 350;
  const heldNameVisible = hud.heldName && now - hud.heldNameAt < 2200;

  if (hud.hudHidden) return null;
  return (
    <div className="absolute inset-0 pointer-events-none bc-shadow">
      {hurtFlash && <div className="absolute inset-0" style={{ boxShadow: "inset 0 0 120px 40px rgba(200,0,0,0.45)" }} />}
      {hud.onFire && survival && <div className="absolute inset-x-0 bottom-0 h-1/3" style={{ background: "linear-gradient(transparent, rgba(255,110,0,0.35))" }} />}
      {hud.sleeping > 0 && <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${hud.sleeping * 0.8})` }} />}

      {crosshair && hud.gameMode !== "spectator" && !hud.screen && (
        <div className="absolute left-1/2 top-1/2" style={{ transform: "translate(-50%, -50%)", mixBlendMode: "difference" }}>
          <div style={{ position: "absolute", width: "calc(var(--u) * 9)", height: "calc(var(--u) * 1)", left: "calc(var(--u) * -4.5)", top: "calc(var(--u) * -0.5)", background: "#fff" }} />
          <div style={{ position: "absolute", width: "calc(var(--u) * 1)", height: "calc(var(--u) * 9)", left: "calc(var(--u) * -0.5)", top: "calc(var(--u) * -4.5)", background: "#fff" }} />
          {survival && hud.attackCharge < 1 && (
            <div style={{ position: "absolute", top: "calc(var(--u) * 7)", left: "calc(var(--u) * -8)", width: "calc(var(--u) * 16)", height: "calc(var(--u) * 2)", background: "#333" }}>
              <div style={{ width: `${hud.attackCharge * 100}%`, height: "100%", background: "#ddd" }} />
            </div>
          )}
        </div>
      )}

      {hud.title && (
        <div className="absolute left-0 right-0 text-center" style={{ top: "30%", animation: "bc-fadeout 4s forwards" }}>
          <div style={{ fontSize: "calc(var(--u) * 20)" }}>{hud.title.text}</div>
          {hud.title.sub && <div style={{ fontSize: "calc(var(--u) * 9)", color: "#ddd" }}>{hud.title.sub}</div>}
        </div>
      )}

      {hud.effects.length > 0 && !hud.screen && (
        <div className="absolute flex flex-col items-end" style={{ right: "calc(var(--u) * 3)", top: mobile ? "calc(var(--u) * 26)" : "calc(var(--u) * 3)", gap: "calc(var(--u) * 1)" }}>
          {hud.effects.map((e) => (
            <div key={e.kind} style={{ background: "rgba(0,0,0,0.45)", padding: "calc(var(--u) * 1) calc(var(--u) * 3)", fontSize: "calc(var(--u) * 5.5)" }}>
              {effectName(e.kind, e.amp)} <span style={{ color: e.seconds <= 10 ? "#ff8080" : "#c0c0c0" }}>{clock(e.seconds)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Bottom cluster: status bars, XP, hotbar. */}
      <div className="absolute left-1/2 flex flex-col items-center" style={{ bottom: mobile ? "calc(var(--u) * 2)" : "calc(var(--u) * 1)", transform: "translateX(-50%)" }}>
        {hud.actionbar && <div style={{ fontSize: "calc(var(--u) * 7)", marginBottom: "calc(var(--u) * 4)" }}>{hud.actionbar.text}</div>}
        {heldNameVisible && !hud.actionbar && <div style={{ fontSize: "calc(var(--u) * 7)", marginBottom: "calc(var(--u) * 4)" }}>{hud.heldName}</div>}
        {survival && (
          <div style={{ display: "flex", justifyContent: "space-between", width: "calc(var(--u) * 182)", alignItems: "flex-end" }}>
            <div>
              {hud.armor > 0 && <Row full={hud.armor} max={20} icon="armor" half="armorHalf" empty="heartEmpty" />}
              {hud.absorption > 0 && <Row full={hud.absorption} max={hud.absorption} icon="heartGold" half="heartGold" empty="heartGold" />}
              <Row full={Math.ceil(hud.health)} max={20} icon="heart" half="heartHalf" empty="heartEmpty" shake={hud.health <= 4} />
            </div>
            <div>
              {hud.underwater && hud.air < 300 && (
                <div style={{ display: "flex", flexDirection: "row-reverse" }}>
                  {Array.from({ length: Math.ceil(Math.max(0, hud.air) / 30) }, (_, i) => <img key={i} src={glyph("bubble")} className="bc-glyph" alt="" />)}
                </div>
              )}
              <Row full={hud.food} max={20} icon="food" half="foodHalf" empty="foodEmpty" reverse />
            </div>
          </div>
        )}
        {survival && (
          <div style={{ position: "relative", width: "calc(var(--u) * 182)", height: "calc(var(--u) * 5)", margin: "calc(var(--u) * 1) 0", background: "#1a1a1a", border: "calc(var(--u) * 0.5) solid #000" }}>
            <div style={{ width: `${hud.xpProgress * 100}%`, height: "100%", background: "linear-gradient(#b4ff5a, #6ab21c)" }} />
            {hud.xpLevel > 0 && (
              <div style={{ position: "absolute", left: "50%", top: "calc(var(--u) * -8)", transform: "translateX(-50%)", color: "#80ff20", fontSize: "calc(var(--u) * 8)", textShadow: "calc(var(--u)*0.6) calc(var(--u)*0.6) 0 #000" }}>{hud.xpLevel}</div>
            )}
          </div>
        )}
        {hud.gameMode !== "spectator" && (
          <div className="bc-hotbar">
            {hud.hotbar.map((s, i) => (
              <div key={i} className={`bc-hslot ${i === hud.selected ? "sel" : ""}`}>
                <StackView stack={s} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Chat. */}
      <div className="absolute left-0" style={{ bottom: mobile ? "calc(var(--u) * 70)" : "calc(var(--u) * 48)", maxWidth: "min(90vw, calc(var(--u) * 240))", padding: "0 calc(var(--u) * 2)" }}>
        {hud.chat.filter((l) => hud.screen?.kind === "chat" || now - l.at < 10000).slice(-10).map((l) => (
          <div key={l.id} style={{ fontSize: "calc(var(--u) * 6.5)", color: l.color ?? "#fff", background: "rgba(0,0,0,0.4)", padding: "calc(var(--u) * 0.5) calc(var(--u) * 2)", opacity: hud.screen?.kind === "chat" ? 1 : Math.min(1, (10000 - (now - l.at)) / 1500) }}>
            {l.text}
          </div>
        ))}
      </div>

      {/* Corners. */}
      {!hud.debug && (hud.coords || hud.fps > 0) && (
        <div className="absolute" style={{ left: "calc(var(--u) * 3)", top: mobile ? "calc(var(--u) * 22)" : "calc(var(--u) * 3)", fontSize: "calc(var(--u) * 6)", lineHeight: 1.4 }}>
          {hud.coords && <div style={{ background: "rgba(0,0,0,0.35)", padding: "0 calc(var(--u) * 2)" }}>XYZ: {hud.coords}</div>}
        </div>
      )}
      {hud.debug && (
        <div className="absolute" style={{ left: "calc(var(--u) * 2)", top: "calc(var(--u) * 2)", fontSize: "calc(var(--u) * 5.5)", lineHeight: 1.35 }}>
          {hud.debug.map((l, i) => <div key={i} style={{ background: "rgba(80,80,80,0.55)", padding: "0 calc(var(--u) * 1.5)", width: "fit-content" }}>{l}</div>)}
        </div>
      )}
      {hud.net && (
        <div className="absolute" style={{ right: "calc(var(--u) * 3)", top: mobile ? "calc(var(--u) * 22)" : "calc(var(--u) * 3)", fontSize: "calc(var(--u) * 6)", textAlign: "right", background: "rgba(0,0,0,0.35)", padding: "calc(var(--u) * 1) calc(var(--u) * 3)" }}>
          <div>{hud.net.role === "host" ? "Hosting" : "Joined"} · {hud.net.kind === "online" ? "online" : "this device"} · room <span style={{ color: "#ffff80" }}>{hud.net.room}</span></div>
          <div style={{ color: hud.net.status === "connected" ? "#9f9" : "#fc6" }}>{hud.net.players.length} player{hud.net.players.length === 1 ? "" : "s"} · {hud.net.status}</div>
        </div>
      )}
      {hud.toasts.length > 0 && (
        <div className="absolute" style={{ right: "calc(var(--u) * 2)", top: mobile ? "calc(var(--u) * 40)" : "calc(var(--u) * 2)", display: "flex", flexDirection: "column", gap: "calc(var(--u) * 2)" }}>
          {hud.toasts.map((t) => (
            <div key={t.id} style={{
              width: "calc(var(--u) * 160)", display: "flex", gap: "calc(var(--u) * 4)", alignItems: "center", padding: "calc(var(--u) * 4)",
              background: "#212121", border: "calc(var(--u) * 1) solid #000", boxShadow: "inset 0 0 0 calc(var(--u) * 1) #555",
              animation: "bc-toast 5s ease-in-out forwards",
            }}>
              <ItemIcon id={itemId(t.icon)} />
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "#ffff55", fontSize: "calc(var(--u) * 6.5)" }}>Advancement Made!</div>
                <div style={{ color: "#fff", fontSize: "calc(var(--u) * 6.5)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      {hud.saving && <div className="absolute" style={{ right: "calc(var(--u) * 3)", bottom: "calc(var(--u) * 3)", fontSize: "calc(var(--u) * 6)", color: "#ddd" }}>Saving world…</div>}

      {hud.loading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-auto" style={{ backgroundImage: `url(${textureBackground("dirt", 0.55)})`, backgroundSize: "calc(var(--u) * 32)", imageRendering: "pixelated" }}>
          <div style={{ fontSize: "calc(var(--u) * 9)", marginBottom: "calc(var(--u) * 6)" }}>{hud.loading.message}…</div>
          <div style={{ width: "calc(var(--u) * 120)", height: "calc(var(--u) * 4)", background: "#1a1a1a", border: "calc(var(--u) * 0.5) solid #000" }}>
            <div style={{ width: `${hud.loading.total ? (hud.loading.done / hud.loading.total) * 100 : 5}%`, height: "100%", background: "#80ff20", transition: "width 0.2s" }} />
          </div>
          <div className="bc-sub" style={{ marginTop: "calc(var(--u) * 4)" }}>{hud.loading.done} / {hud.loading.total} chunks</div>
        </div>
      )}
    </div>
  );
}
