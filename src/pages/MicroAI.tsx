import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { ModelSelector } from "@/components/microai/ModelSelector";
import { PerfMonitor } from "@/components/microai/PerfMonitor";
import { routeMicroPrompt, readMicroLog, clearMicroLog, type MicroRunMetrics, type MicroLogEntry } from "@/lib/microai/router";
import { readSettings, writeSettings } from "@/lib/microai/settings";
import { Terminal, Brain, Trash2, ClipboardPaste } from "lucide-react";

interface TermLine { role: "in" | "out" | "sys"; text: string; }

export default function MicroAI() {
  const { toast } = useToast();
  const initial = readSettings();
  const [activeModel, setActiveModel] = useState<string>(initial.modelId);
  const [seedling, setSeedling] = useState<boolean>(initial.seedling);
  const [temperature, setTemperature] = useState<number>(initial.temperature);
  const [maxTokens, setMaxTokens] = useState<number>(initial.maxTokens);
  const [termInput, setTermInput] = useState("");
  const [termLines, setTermLines] = useState<TermLine[]>([{ role: "sys", text: `micro terminal ready. active: ${initial.modelId} · temp ${initial.temperature} · ${initial.maxTokens} tokens · Seedling lock: ${initial.seedling ? "ON" : "OFF"}.` }]);
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantReply, setAssistantReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [metrics, setMetrics] = useState<MicroRunMetrics | null>(null);
  const [log, setLog] = useState<MicroLogEntry[]>(() => readMicroLog());
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    termRef.current?.scrollTo({ top: termRef.current.scrollHeight });
  }, [termLines]);

  const locked = seedling;

  useEffect(() => {
    writeSettings({ modelId: activeModel, temperature, maxTokens, seedling });
  }, [activeModel, temperature, maxTokens, seedling]);

  const switchModel = (id: string) => {
    if (locked) return;
    setActiveModel(id);
    setTermLines(l => [...l, { role: "sys", text: `active model → ${id} (saved)` }]);
  };

  const toggleSeedling = (on: boolean) => {
    setSeedling(on);
    setTermLines(l => [...l, { role: "sys", text: `Seedling lock: ${on ? "ON — terminal + switching locked" : "OFF"}` }]);
  };

  const runTerminal = async (raw?: string) => {
    const cmd = (raw ?? termInput).trim();
    if (!cmd || busy || locked) return;
    setBusy(true);
    setTermLines(l => [...l, { role: "in", text: cmd }]);
    setTermInput("");
    const res = await routeMicroPrompt(cmd, activeModel);
    setMetrics(res.metrics);
    setLog(readMicroLog());
    setTermLines(l => [...l, { role: res.metrics.error ? "sys" : "out", text: res.metrics.error ? `error: ${res.metrics.error}` : res.text || "(empty response)" }]);
    setBusy(false);
  };

  const quickPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        setTermInput(text.trim());
        toast({ title: "Pasted", description: "Clipboard loaded into terminal." });
      }
    } catch {
      toast({ title: "Clipboard blocked", description: "Grant clipboard permission to quick-paste.", variant: "destructive" });
    }
  };

  const runAssistant = async () => {
    const q = assistantInput.trim();
    if (!q || busy) return;
    setBusy(true);
    setAssistantReply("");
    const res = await routeMicroPrompt(q, activeModel,
      "You are Jacky, a small local assistant. Answer briefly and factually. Never claim to modify files; describe steps only. Confirmation is required before any file write.");
    setMetrics(res.metrics);
    setLog(readMicroLog());
    setAssistantReply(res.metrics.error ? `⚠ ${res.metrics.error}` : res.text);
    setBusy(false);
  };

  return (
    <div className="min-h-screen bg-background p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="font-display text-2xl text-foreground">🧬 Jacky Micro-AI</h1>
          <p className="text-xs text-muted-foreground">Local micro-LLMs via LM Studio / Ollama at localhost:11434</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-muted-foreground">Seedling {seedling ? "ON" : "OFF"}</span>
          <Switch checked={seedling} onCheckedChange={toggleSeedling} />
          <Badge variant="outline" className="text-[10px] font-mono">active: {activeModel}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="space-y-4">
          <ModelSelector activeModel={activeModel} locked={locked} onSelect={switchModel} />
          <PerfMonitor metrics={metrics} />
        </div>

        <Card className="bg-card/80 border-border/40 lg:col-span-1 flex flex-col">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-wider flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-primary" /> Micro Terminal
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 flex flex-col flex-1 gap-2 min-h-0">
            <div ref={termRef} className="flex-1 overflow-y-auto rounded-md bg-muted/30 border border-border/40 p-2 font-mono text-[11px] space-y-1 min-h-[220px] max-h-[320px]">
              {termLines.map((l, i) => (
                <div key={i} className={l.role === "in" ? "text-primary" : l.role === "out" ? "text-foreground" : "text-muted-foreground italic"}>
                  {l.role === "in" ? "❯ " : l.role === "out" ? "◈ " : "· "}{l.text}
                </div>
              ))}
              {busy && <div className="text-muted-foreground animate-pulse">◈ thinking…</div>}
            </div>
            <div className="flex gap-2">
              <Input
                value={termInput}
                onChange={e => setTermInput(e.target.value)}
                placeholder={locked ? "Seedling ON — locked" : "Send to micro model…"}
                disabled={locked || busy}
                className="text-xs font-mono"
                onKeyDown={e => { if (e.key === "Enter") runTerminal(); }}
              />
              <Button size="sm" variant="outline" onClick={quickPaste} disabled={locked || busy} title="Quick-paste from clipboard">
                <ClipboardPaste className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" onClick={() => runTerminal()} disabled={locked || busy || !termInput.trim()}>
                {busy ? "…" : "Run"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card/80 border-border/40 flex flex-col">
          <CardHeader className="p-3 pb-2">
            <CardTitle className="text-xs font-mono uppercase tracking-wider flex items-center gap-2">
              <Brain className="h-3.5 w-3.5 text-primary" /> Assistant
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-0 flex flex-col flex-1 gap-2">
            <Textarea
              value={assistantInput}
              onChange={e => setAssistantInput(e.target.value)}
              placeholder="Short reasoning, code explanation, or repair question…"
              className="min-h-[70px] text-xs"
              disabled={busy}
            />
            <Button size="sm" onClick={runAssistant} disabled={busy || !assistantInput.trim()}>
              {busy ? "Thinking…" : "Ask"}
            </Button>
            <div className="rounded-md bg-muted/30 border border-border/40 p-2 text-[12px] text-foreground whitespace-pre-wrap min-h-[120px]">
              {assistantReply || <span className="text-muted-foreground">Assistant replies here. It never writes files without your confirmation.</span>}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card/80 border-border/40">
        <CardHeader className="p-3 pb-2 flex-row items-center justify-between">
          <CardTitle className="text-xs font-mono uppercase tracking-wider">Interaction Log ({log.length})</CardTitle>
          <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { clearMicroLog(); setLog([]); }}>
            <Trash2 className="h-3 w-3 mr-1" /> Clear
          </Button>
        </CardHeader>
        <CardContent className="p-3 pt-0 max-h-48 overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No interactions logged yet.</p>
          ) : (
            <div className="space-y-1 font-mono text-[10px]">
              {[...log].reverse().slice(0, 30).map((e, i) => (
                <div key={i} className="border-b border-border/20 pb-1">
                  <span className="text-muted-foreground">{new Date(e.ts).toLocaleTimeString()}</span>{" "}
                  <span className="text-primary">{e.model}</span>
                  {e.fellBack && <span className="text-amber-500"> [fallback]</span>}
                  {e.error && <span className="text-destructive"> [err]</span>}
                  <span className="text-muted-foreground"> — {e.latencyMs.toFixed(0)}ms</span>
                  <div className="text-foreground/70 truncate">❯ {e.prompt}</div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
