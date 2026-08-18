import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { RUNNERS, findRunner, humanSize, type Platform, type RunnerId } from "@/lib/repair/modelBridge";
import {
  ASSET_LABEL, SOURCES, buildWizardPlan, clearWizardRun, findSource, loadWizardRun,
  saveWizardRun, wizardMarkdown, wizardProgress,
  type SourceId, type WizardRun,
} from "@/lib/repair/conversionWizard";
import {
  DEFAULT_PROMPT, VERDICT_LABEL, checksCsv, checksMarkdown, clearChecks, judgeSmokeTest,
  latestByTarget, loadChecks, newCheckId, recordCheck, smokeTestCommand,
  type CheckRecord,
} from "@/lib/repair/postConvertCheck";

export type WizardExecResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  durationMs: number;
};

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground">
      {children}
    </pre>
  );
}

const VERDICT_CLASS: Record<CheckRecord["verdict"], string> = {
  pass: "bg-emerald-500/15 text-emerald-500",
  fail: "bg-destructive/15 text-destructive",
  unclear: "bg-amber-500/15 text-amber-500",
};

export default function ConversionWizard({
  platform, onRun, onExec, onCopy, onDownload, presetPath, presetSource, presetSize,
}: {
  platform: Platform;
  onRun?: (c: string) => void;
  /** Runs a command through the bridge and returns its result, for automated verification. */
  onExec?: (c: string) => Promise<WizardExecResult | null>;
  onCopy: (c: string) => void;
  onDownload: (name: string, content: string, mime?: string) => void;
  presetPath?: string;
  presetSource?: SourceId;
  presetSize?: number;
}) {

  const saved = useMemo(() => loadWizardRun(), []);
  const [source, setSource] = useState<SourceId>(presetSource ?? saved?.input.source ?? "lmstudio");
  const [target, setTarget] = useState<RunnerId>(saved?.input.target ?? "ollama");
  const [assetPath, setAssetPath] = useState(presetPath ?? saved?.input.assetPath ?? "");
  const [name, setName] = useState(saved?.input.name ?? "");
  const [done, setDone] = useState<string[]>(saved?.done ?? []);
  const [startedAt] = useState(saved?.startedAt ?? new Date().toISOString());

  const plan = useMemo(
    () => buildWizardPlan({ source, target, platform, assetPath, name, sizeBytes: presetSize ?? saved?.input.sizeBytes }),
    [source, target, platform, assetPath, name, presetSize, saved],
  );
  const progress = wizardProgress(plan, done);
  const srcDef = findSource(source);

  useEffect(() => {
    const run: WizardRun = {
      input: { source, target, platform, assetPath, name, sizeBytes: presetSize ?? saved?.input.sizeBytes },
      done,
      startedAt,
      updatedAt: new Date().toISOString(),
    };
    saveWizardRun(run);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, target, assetPath, name, done]);

  const toggle = (id: string) =>
    setDone((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));

  const reset = () => {
    setDone([]);
    clearWizardRun();
  };

  /* ---- automated post-conversion verification ---- */
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [checks, setChecks] = useState<CheckRecord[]>(() => loadChecks());
  const [verifying, setVerifying] = useState<RunnerId | null>(null);
  const latest = useMemo(() => latestByTarget(checks), [checks]);

  const modelRef = (name.trim() || assetPath.trim() || "").trim();

  const verify = async (runner: RunnerId) => {
    if (!onExec) return;
    const test = smokeTestCommand(runner, modelRef, platform, prompt || DEFAULT_PROMPT);
    setVerifying(runner);
    try {
      const r = await onExec(test.command);
      if (!r) return;
      const judged = judgeSmokeTest(r);
      const rec: CheckRecord = {
        id: newCheckId(),
        ts: r.startedAt || new Date().toISOString(),
        target: runner,
        modelRef,
        prompt: prompt || DEFAULT_PROMPT,
        command: test.command,
        exitCode: r.exitCode,
        output: [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n").slice(0, 8000),
        durationMs: r.durationMs ?? 0,
        verdict: judged.verdict,
        reason: judged.reason,
      };
      setChecks(recordCheck(rec));
    } finally {
      setVerifying(null);
    }
  };

  const verifyAll = async () => {
    for (const r of RUNNERS) await verify(r.id);
  };



  return (
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Model Conversion Wizard</h2>
          <Badge variant="outline">{platform === "windows" ? "Windows" : "Linux"}</Badge>
          <Badge className={plan.zeroCopy ? "bg-emerald-500/15 text-emerald-500" : "bg-amber-500/15 text-amber-500"}>
            {plan.zeroCopy ? "No extra copy of the weights" : "Writes a second copy"}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          One asset, one target runner, worked as a checklist you can put down and pick back up. Integrity is proven before
          anything is wired, and no step moves or deletes your original file.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <p className="text-xs text-muted-foreground">1. Where the asset is now</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SOURCES.map((s) => (
                <Button
                  key={s.id}
                  size="sm"
                  variant={source === s.id ? "default" : "secondary"}
                  className="min-h-11"
                  onClick={() => setSource(s.id)}
                >
                  {s.label}
                </Button>
              ))}
            </div>
            {srcDef && <p className="mt-2 text-xs text-muted-foreground">{srcDef.locate}</p>}
          </div>

          <div>
            <p className="text-xs text-muted-foreground">2. Target runner</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {RUNNERS.map((r) => (
                <Button
                  key={r.id}
                  size="sm"
                  variant={target === r.id ? "default" : "secondary"}
                  className="min-h-11"
                  onClick={() => setTarget(r.id)}
                >
                  → {r.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                {source === "ollama" ? "Ollama tag (e.g. qwen2.5-coder:32b)" : "Exact path to the file or folder"}
              </span>
              <Input
                className="min-h-11 font-mono text-xs"
                placeholder={
                  source === "ollama"
                    ? "qwen2.5-coder:32b"
                    : platform === "windows"
                      ? srcDef?.defaultPath.windows
                      : srcDef?.defaultPath.linux
                }
                value={assetPath}
                onChange={(e) => setAssetPath(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">Name to register it under (optional)</span>
              <Input
                className="min-h-11 font-mono text-xs"
                placeholder="leave blank to use the file name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          </div>

          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{ASSET_LABEL[plan.kind]}</Badge>
              {presetSize ? <span className="text-xs text-muted-foreground">{humanSize(presetSize)}</span> : null}
            </div>
            <p className="mt-2 text-sm">{plan.summary}</p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">
              Checklist · {findSource(source)?.label} → {findRunner(target)?.label}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {progress.requiredDone} of {progress.requiredTotal} required steps done ·{" "}
              {progress.allDone} of {progress.allTotal} total
            </p>
          </div>
          {progress.complete && <Badge className="bg-emerald-500/15 text-emerald-500">Required steps complete</Badge>}
        </div>
        <Progress
          className="mt-3"
          value={progress.requiredTotal ? (progress.requiredDone / progress.requiredTotal) * 100 : 0}
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="min-h-11"
            onClick={() => onDownload("model-conversion-checklist.md", wizardMarkdown(plan, done), "text/markdown")}
          >
            Download checklist
          </Button>
          <Button size="sm" variant="secondary" className="min-h-11" onClick={() => onCopy(wizardMarkdown(plan, done))}>
            Copy checklist
          </Button>
          <Button size="sm" variant="ghost" className="min-h-11" onClick={reset}>
            Reset progress
          </Button>
        </div>
      </Card>

      {plan.phases.map((phase) => {
        const phaseDone = phase.items.filter((i) => done.includes(i.id)).length;
        return (
          <Card key={phase.id} className="p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{phase.title}</h3>
              <Badge variant="outline">
                {phaseDone}/{phase.items.length}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{phase.purpose}</p>
            <div className="mt-3 space-y-3">
              {phase.items.map((item) => {
                const checked = done.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className={`rounded-lg border p-3 ${checked ? "border-emerald-500/40 bg-emerald-500/5" : "border-border/60"}`}
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggle(item.id)}
                        className="mt-0.5 h-6 w-6"
                        aria-label={item.title}
                      />
                      <span className="flex-1">
                        <span className="text-sm font-medium">{item.title}</span>
                        {!item.required && (
                          <Badge variant="outline" className="ml-2">
                            optional
                          </Badge>
                        )}
                      </span>
                    </label>
                    {item.command && <Mono>{item.command}</Mono>}
                    {item.note && <p className="mt-1 text-xs text-muted-foreground">{item.note}</p>}
                    {item.command && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" className="min-h-11" onClick={() => onCopy(item.command!)}>
                          Copy
                        </Button>
                        {onRun && (
                          <Button size="sm" className="min-h-11" onClick={() => onRun(item.command!)}>
                            Run on bridge
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}

      {plan.warnings.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold">Read before you write</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {plan.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
