/**
 * The pill — every crafted index, one keystroke away, on every screen.
 *
 * The forge at `/forge` makes indexes. This is where they get used, and it is
 * mounted beside the router rather than on a page so it is there on all of
 * them.
 *
 * Two paths, and the fast one is tried first. "Open Tasks" is matched against
 * the route manifest and the commands crafted indexes declare, and it moves the
 * app immediately — no model, no network, no await. Anything that is not a
 * command is a question, routed to whichever index is expert in it and answered
 * on that index's own ladder. `src/lib/forge/commands.ts` owns the line between
 * the two and is where it is tested.
 *
 * ## The status line is real
 *
 * The mockup this is built from ended in "WASM Ready • Weights Pending Load",
 * next to a console printing invented allocations. Those were decoration. Every
 * word in the footer here is measured: whether this browser has WebAssembly,
 * whether the weights on disk are the model or an LFS pointer, and which engine
 * actually answered the last question. A status line that cannot be wrong is
 * worth more than one that looks busy.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CornerDownLeft, Loader2, Mic, MicOff, Settings2, X } from "lucide-react";
import { DraggableToolbar } from "./DraggableToolbar";
import { listLocal } from "@/lib/forge/store";
import { filterCommands, resolveUtterance, type CommandHit } from "@/lib/forge/commands";
import { listenOnce, speechSupported } from "@/lib/forge/voice";
import type { CraftedIndex } from "@/lib/forge/types";
import { defaultEngines } from "@/lib/microai/contextRouterService";
import { wasmSupported } from "@/lib/microai/deviceEngine";
import { checkGuideWeights } from "@/lib/guide/weights";
import { CONTEXT_ROUTERS } from "@/lib/microai/contextRouter";

interface Status {
  wasm: boolean;
  weights: string;
  weightsReady: boolean;
  engine: string | null;
}

export function IndexPill() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [indexes, setIndexes] = useState<CraftedIndex[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [answer, setAnswer] = useState<{ text: string; via: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listeningRef = useRef<{ stop(): void } | null>(null);
  const enginesRef = useRef(defaultEngines());

  const canListen = useMemo(speechSupported, []);

  // Probed once per open rather than per keystroke: the answer does not change
  // until someone installs weights or starts a runner, and a panel that polls a
  // host which is not there is just noise on the network tab.
  useEffect(() => {
    if (!open) return;
    setIndexes(listLocal());
    inputRef.current?.focus();

    let live = true;
    (async () => {
      const engines = enginesRef.current;
      const [weights, ...up] = await Promise.all([
        checkGuideWeights(),
        ...engines.map((engine) => engine.available()),
      ]);
      if (!live) return;
      const ready = engines.find((_, i) => up[i]);
      setStatus({
        wasm: wasmSupported(),
        weights: weights.detail,
        weightsReady: weights.present,
        engine: ready ? ready.name : null,
      });
    })();
    return () => { live = false; };
  }, [open]);

  useEffect(() => () => listeningRef.current?.stop(), []);

  const commands = useMemo(() => filterCommands(query, indexes), [query, indexes]);

  const run = useCallback(
    async (raw: string) => {
      const resolution = resolveUtterance(raw, indexes);
      if (!resolution) return;

      if (resolution.kind === "command") {
        // The fast path, and it really is fast: a string comparison over a list
        // already in memory, then a navigation.
        setOpen(false);
        setQuery("");
        navigate(resolution.path);
        return;
      }

      const index = resolution.index;
      if (!index) {
        setNote(
          indexes.length === 0
            ? "No indexes crafted yet — build one in the Forge, or say a command like “Open Vault”."
            : "No index claimed that. Add a keyword for it in the Forge, or say a command.",
        );
        return;
      }

      setBusy(true);
      setNote(null);
      setAnswer(null);
      try {
        const allowed = new Set(index.ladder);
        const engines = enginesRef.current.filter((engine) => allowed.has(engine.locality));
        for (const engine of engines) {
          if (!(await engine.available())) continue;
          const result = await engine.run(
            `${index.systemPrompt}\n\n${resolution.text}`,
            index.modelId,
          );
          setAnswer({ text: result.text, via: `${index.name} · ${engine.name} · ${result.model}` });
          return;
        }
        // Named rather than swallowed: the ladder this index declared is the
        // reason nothing answered, and the person chose that ladder.
        setNote(`Nothing on ${index.name}'s ladder (${index.ladder.join(" → ")}) is ready.`);
      } catch (error) {
        setNote(error instanceof Error ? error.message : "That failed.");
      } finally {
        setBusy(false);
      }
    },
    [indexes, navigate],
  );

  const toggleListening = () => {
    if (listening) {
      listeningRef.current?.stop();
      listeningRef.current = null;
      setListening(false);
      return;
    }
    setNote(null);
    const handle = listenOnce({
      onPartial: setQuery,
      onFinal: (text) => {
        setListening(false);
        listeningRef.current = null;
        setQuery(text);
        run(text);
      },
      onError: (message) => {
        setListening(false);
        listeningRef.current = null;
        setNote(message);
      },
    });
    if (!handle) {
      setNote("This browser cannot listen. Type instead.");
      return;
    }
    listeningRef.current = handle;
    setListening(true);
  };

  if (!open) {
    return (
      <DraggableToolbar storageKey="index-pill" defaultRow={1}>
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-full border border-primary/40 bg-card/95 px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground shadow-lg backdrop-blur transition-colors hover:border-primary"
          aria-label="Open the index launcher"
        >
          <span className="relative">
            <Bot size={16} className="text-primary" />
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
          </span>
          Index
          {canListen && <Mic size={13} className="text-muted-foreground" />}
        </button>
      </DraggableToolbar>
    );
  }

  return (
    <DraggableToolbar storageKey="index-pill" defaultRow={1}>
      <div className="w-[min(92vw,420px)] overflow-hidden rounded-xl border border-primary/30 bg-card/98 shadow-2xl backdrop-blur">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Bot size={15} className="text-primary" />
          <span className="font-mono text-xs uppercase tracking-widest">Index Finder</span>
          <div className="flex-1" />
          <button
            onClick={() => { setOpen(false); navigate("/forge"); }}
            className="text-muted-foreground hover:text-primary"
            aria-label="Open the Index Forge"
            title="Craft indexes"
          >
            <Settings2 size={14} />
          </button>
          <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") run(query); if (e.key === "Escape") setOpen(false); }}
            placeholder='Say "Open Vault" or ask a question…'
            className="flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {busy ? (
            <Loader2 size={14} className="animate-spin text-primary" />
          ) : (
            <button onClick={() => run(query)} className="text-muted-foreground hover:text-primary" aria-label="Run">
              <CornerDownLeft size={14} />
            </button>
          )}
          {/* Absent rather than dead where the browser cannot listen: a button
              that does nothing when pressed leaves the person unable to tell
              whether it failed or was never there. */}
          {canListen && (
            <button
              onClick={toggleListening}
              className={listening ? "text-primary" : "text-muted-foreground hover:text-primary"}
              aria-label={listening ? "Stop listening" : "Speak"}
            >
              {listening ? <MicOff size={14} /> : <Mic size={14} />}
            </button>
          )}
        </div>

        <div className="max-h-[46vh] overflow-y-auto">
          {answer && (
            <div className="space-y-1 border-b border-border p-3">
              <p className="font-mono text-[10px] text-primary">{answer.via}</p>
              <p className="whitespace-pre-wrap text-xs text-foreground">{answer.text}</p>
            </div>
          )}
          {note && <p className="border-b border-border p-3 text-[11px] text-yellow-500">{note}</p>}

          <div className="p-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Commands — no model, no wait
            </p>
            <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
              {commands.map((command: CommandHit) => (
                <li key={`${command.path}:${command.label}`}>
                  <button
                    onClick={() => { setOpen(false); setQuery(""); navigate(command.path); }}
                    className="w-full truncate text-left font-mono text-[11px] text-muted-foreground hover:text-primary"
                    title={command.path}
                  >
                    · {command.label}
                  </button>
                </li>
              ))}
            </ul>
            {indexes.length > 0 && (
              <p className="mt-3 font-mono text-[10px] text-muted-foreground">
                {indexes.length} crafted index{indexes.length === 1 ? "" : "es"} ·{" "}
                {CONTEXT_ROUTERS.length} built in
              </p>
            )}
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span className={status?.wasm ? "text-primary" : "text-yellow-500"}>
            {status ? (status.wasm ? "WASM ready" : "no WASM") : "checking…"}
          </span>
          <span>·</span>
          <span className={status?.weightsReady ? "" : "text-yellow-500"} title={status?.weights}>
            {status ? (status.weightsReady ? "weights on disk" : "weights missing") : "…"}
          </span>
          <span>·</span>
          <span>{status?.engine ? `${status.engine} ready` : "no engine ready"}</span>
        </footer>
      </div>
    </DraggableToolbar>
  );
}
