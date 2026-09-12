import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { DraggableToolbar } from "./DraggableToolbar";
import { Compass, CornerDownLeft, Loader2, X } from "lucide-react";
import { askGuide, type GuideAnswer } from "@/lib/guide/guideService";
import { ollamaEngine } from "@/lib/microai/contextRouterService";
import { checkGuideWeights, GUIDE_INSTALL_COMMAND, GUIDE_WEIGHTS_MB } from "@/lib/guide/weights";
import { GUIDANCE_MODEL } from "@/lib/microai/models";

/**
 * The guide, on every screen.
 *
 * Permanent in the two senses that matter: it is mounted beside the router
 * rather than on a page, so it is there on all of the app's routes; and it
 * always answers, because the routes come from the manifest whether or not the
 * model is installed. The model only writes the sentence around them.
 */
export function GuideDock() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<GuideAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [model, setModel] = useState<{ ready: boolean; detail: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const engineRef = useRef(ollamaEngine());

  // One probe per open, not per keystroke: the answer is the same until someone
  // installs the model, and the panel should not poll a host that is not there.
  useEffect(() => {
    if (!open) return;
    let live = true;
    (async () => {
      const [weights, engineUp] = await Promise.all([
        checkGuideWeights(),
        engineRef.current.available(),
      ]);
      if (!live) return;
      setModel({
        ready: engineUp,
        detail: engineUp
          ? `${GUIDANCE_MODEL.name} via Ollama`
          : weights.present
            ? `Weights are here (${GUIDE_WEIGHTS_MB} MB) — install them: ${GUIDE_INSTALL_COMMAND}`
            : weights.detail,
      });
    })();
    inputRef.current?.focus();
    return () => { live = false; };
  }, [open]);

  const ask = useCallback(async () => {
    const asked = question.trim();
    if (!asked || asking) return;
    setAsking(true);
    try {
      const engine = engineRef.current;
      const ready = new Set<string>();
      if (await engine.available()) ready.add(engine.id);
      setAnswer(await askGuide(asked, { engines: [engine], ready }));
    } finally {
      setAsking(false);
    }
  }, [question, asking]);

  return (
    <>
      <DraggableToolbar storageKey="jackie.guide.toolbar.v1" defaultRow={2}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title="Guide — how do I use this?"
          aria-label="Open the guide"
          className={`p-1.5 rounded-full transition-colors ${
            open ? "text-primary bg-secondary" : "text-muted-foreground hover:text-foreground hover:bg-secondary"
          }`}
        >
          <Compass size={16} />
        </button>
        <span className="text-[10px] px-2 py-0.5 rounded bg-secondary text-muted-foreground">Guide</span>
      </DraggableToolbar>

      {open && (
        <div className="fixed inset-x-3 bottom-24 z-[70] mx-auto max-w-lg rounded-xl border border-border bg-popover/98 backdrop-blur-md shadow-xl sm:inset-x-auto sm:right-6 sm:w-[26rem]">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <Compass size={14} className="text-primary" />
            <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">Guide</span>
            <span className="ml-auto truncate text-[10px] text-muted-foreground" title={model?.detail}>
              {model ? (model.ready ? GUIDANCE_MODEL.name : "map only") : "checking…"}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the guide"
              className="p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              <X size={14} />
            </button>
          </div>

          <div className="p-3 space-y-3">
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
                placeholder="How do I… / Where is…"
                className="min-h-11 flex-1 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={ask}
                disabled={asking || !question.trim()}
                aria-label="Ask the guide"
                className="min-h-11 rounded-md border border-border px-3 text-muted-foreground hover:text-foreground hover:bg-secondary disabled:opacity-40"
              >
                {asking ? <Loader2 size={14} className="animate-spin" /> : <CornerDownLeft size={14} />}
              </button>
            </div>

            {answer && (
              <div className="space-y-2">
                <p className="text-sm leading-snug text-foreground">{answer.text}</p>
                {answer.routes.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {answer.routes.map((route) => (
                      <button
                        key={route.path}
                        type="button"
                        onClick={() => { navigate(route.path); setOpen(false); }}
                        className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 font-mono text-[11px] text-primary hover:bg-primary/20"
                      >
                        {route.path}
                      </button>
                    ))}
                  </div>
                )}
                <p className="font-mono text-[10px] text-muted-foreground">
                  {answer.fromModel ? "answered by " + GUIDANCE_MODEL.name : "from the route manifest"} · {answer.reason}
                </p>
              </div>
            )}

            {!answer && model && !model.ready && (
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">{model.detail}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
