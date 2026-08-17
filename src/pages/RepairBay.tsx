import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RIG, RIG_NAME, RAID_PLAN_NOTES } from "@/lib/repair/rigProfile";
import { PLAYBOOKS, FLASH_RULES, type Playbook } from "@/lib/repair/playbooks";
import { TOOLKIT, CORRECTIONS } from "@/lib/repair/toolkit";
import {
  loadFirmware, saveFirmware, loadCaptures, saveCaptures, newId, exportJson,
  type FirmwareEntry, type SessionCapture,
} from "@/lib/repair/repairStore";
import { scoreAll, VERDICT_LABEL, type RiskScore, type Verdict } from "@/lib/repair/firmwareRisk";
import { VENTOY_STEPS, ISO_CHECKLIST, CHECKLIST_KEY } from "@/lib/repair/ventoy";
import {
  loadDraft, saveDraft, clearDraft, registerContextSource, guardSwitch,
} from "@/lib/repair/contextGuard";
import { orchestrate } from "@/lib/jackie-orchestrator";

type Tab = "rig" | "playbooks" | "toolkit" | "firmware" | "risk" | "bootstick" | "capture" | "consult";

const TABS: { id: Tab; label: string }[] = [
  { id: "rig", label: "Rig Profile" },
  { id: "playbooks", label: "Repair Playbooks" },
  { id: "toolkit", label: "AI + Repair Toolkit" },
  { id: "firmware", label: "Firmware Log" },
  { id: "risk", label: "Update Risk" },
  { id: "bootstick", label: "Boot Stick Wizard" },
  { id: "capture", label: "Session Capture" },
  { id: "consult", label: "Consultant" },
];



/** The factual rig brief every consultant answer is grounded in. */
function rigBrief() {
  const parts = RIG.map((c) => `- ${c.category}: ${c.name} — ${c.detail}`).join("\n");
  return `Operator's workstation — ${RIG_NAME}\n${parts}\n\nStorage/RAID intent notes:\n${RAID_PLAN_NOTES.map((n) => `- ${n}`).join("\n")}`;
}

const CONSULT_SYSTEM = `You are Jackie, acting as this operator's computer repair and maintenance crew.

You always answer against the exact hardware below. Never give generic PC advice when a rig-specific answer exists.

${rigBrief()}

Rules you follow without exception:
- Diagnose before prescribing. Name the cheapest check that would rule your theory in or out, and put it first.
- Never invent firmware or BIOS version numbers. If a version matters, say which vendor page to read and what to look for.
- Flag anything destructive (array creation, flashing, partitioning, CMOS clear) before the step, not after.
- Write for someone who is confident but not a technician: plain steps, real commands, one clear "why" per step.
- If the honest answer is "this needs hands on the hardware" or "back up first", say that plainly.
- Do not pad. Short, ordered, specific.`;

function SeverityBadge({ s }: { s: Playbook["severity"] }) {
  const variant = s === "emergency" ? "destructive" : s === "repair" ? "default" : "secondary";
  return <Badge variant={variant as never}>{s}</Badge>;
}

export default function RepairBay() {
  const [tab, setTab] = useState<Tab>("rig");
  const [query, setQuery] = useState("");
  const [openPb, setOpenPb] = useState<string | null>(PLAYBOOKS[0]?.id ?? null);

  const [firmware, setFirmware] = useState<FirmwareEntry[]>([]);
  const [captures, setCaptures] = useState<SessionCapture[]>([]);
  const [capTitle, setCapTitle] = useState("");
  const [capBody, setCapBody] = useState("");

  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

  useEffect(() => {
    setFirmware(loadFirmware());
    setCaptures(loadCaptures());
  }, []);

  const filteredPlaybooks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return PLAYBOOKS;
    return PLAYBOOKS.filter((p) =>
      [p.title, p.symptom, p.os, p.severity, ...p.steps.map((s) => s.do)]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [query]);

  const upsertFirmware = (componentId: string, patch: Partial<FirmwareEntry>) => {
    setFirmware((prev) => {
      const existing = prev.find((r) => r.componentId === componentId);
      const next = existing
        ? prev.map((r) => (r.componentId === componentId ? { ...r, ...patch } : r))
        : [
            ...prev,
            {
              id: newId(),
              componentId,
              currentVersion: "",
              latestSeen: "",
              checkedAt: new Date().toISOString(),
              note: "",
              status: "unknown" as const,
              ...patch,
            },
          ];
      saveFirmware(next);
      return next;
    });
  };

  const reviewFirmware = async (componentId: string) => {
    const comp = RIG.find((c) => c.id === componentId);
    const row = firmware.find((r) => r.componentId === componentId);
    if (!comp) return;
    if (!row?.currentVersion && !row?.latestSeen) {
      toast.error("Log a version first — Jackie reviews what you observed, she doesn't guess versions.");
      return;
    }
    setBusy(true);
    setTab("consult");
    setAsk(`Firmware review: ${comp.name}`);
    setAnswer("");
    try {
      const r = await orchestrate({
        system: CONSULT_SYSTEM,
        kind: "reasoning",
        prompt: `Firmware/driver review request.

Component: ${comp.name} (${comp.category})
Installed version I observed: ${row?.currentVersion || "(not logged)"}
Latest version I observed on the vendor page: ${row?.latestSeen || "(not logged)"}
My note: ${row?.note || "(none)"}
Official source for this part: ${comp.firmwareSource?.url ?? "unknown"}

Tell me: (1) is this update worth taking for MY use case, or is it risk with no reward; (2) what specifically to read in the changelog before deciding; (3) the safe flashing procedure for this exact part on this exact board; (4) what breaks or resets afterwards and what I should record first. Do not state version numbers I did not give you as fact.`,
      });
      setAnswer(r.output);
      setModelUsed(r.modelUsed);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(false);
    }
  };

  const runConsult = async (prompt?: string) => {
    const q = (prompt ?? ask).trim();
    if (!q) return;
    setBusy(true);
    setAnswer("");
    setAsk(q);
    try {
      const recent = captures.slice(0, 2).map((c) => `### ${c.title}\n${c.body.slice(0, 2000)}`).join("\n\n");
      const r = await orchestrate({
        system: CONSULT_SYSTEM,
        kind: "reasoning",
        prompt: recent ? `${q}\n\n---\nRecent session context I saved:\n${recent}` : q,
      });
      setAnswer(r.output);
      setModelUsed(r.modelUsed);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Consultant unavailable");
    } finally {
      setBusy(false);
    }
  };

  const addCapture = () => {
    if (!capBody.trim()) return;
    const row: SessionCapture = {
      id: newId(),
      createdAt: new Date().toISOString(),
      title: capTitle.trim() || `Capture ${new Date().toLocaleString()}`,
      body: capBody,
    };
    const next = [row, ...captures];
    setCaptures(next);
    saveCaptures(next);
    setCapTitle("");
    setCapBody("");
    toast.success("Saved on this device — survives closing the window.");
  };

  const removeCapture = (id: string) => {
    const next = captures.filter((c) => c.id !== id);
    setCaptures(next);
    saveCaptures(next);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto max-w-5xl px-4 py-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Repair Bay</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Jackie as your repair and maintenance crew — grounded in your actual rig, not generic PC advice.
              </p>
            </div>
            <Link to="/" className="text-sm text-muted-foreground underline underline-offset-4">
              Back to Jackie
            </Link>
          </div>

          <nav className="mt-5 flex flex-wrap gap-2">
            {TABS.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={tab === t.id ? "default" : "outline"}
                onClick={() => setTab(t.id)}
                className="min-h-11"
              >
                {t.label}
              </Button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "rig" && (
          <section className="space-y-4">
            <Card className="p-4">
              <h2 className="font-medium">{RIG_NAME}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Every consultant answer and firmware review on this page is anchored to these parts.
              </p>
            </Card>

            {RIG.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Badge variant="secondary">{c.category}</Badge>
                    <h3 className="mt-2 font-medium">{c.name}</h3>
                  </div>
                  {c.firmwareSource && (
                    <a
                      href={c.firmwareSource.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-h-11 text-sm underline underline-offset-4"
                    >
                      {c.firmwareSource.label} ↗
                    </a>
                  )}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{c.detail}</p>
                {c.watchFor && (
                  <ul className="mt-3 space-y-1 text-sm">
                    {c.watchFor.map((w) => (
                      <li key={w} className="text-muted-foreground">• {w}</li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}

            <Card className="p-4">
              <h3 className="font-medium">RAID intent — honest review</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {RAID_PLAN_NOTES.map((n) => <li key={n}>• {n}</li>)}
              </ul>
            </Card>
          </section>
        )}

        {tab === "playbooks" && (
          <section className="space-y-4">
            <Input
              placeholder="Search symptoms, commands, OS…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="min-h-11"
            />
            {filteredPlaybooks.map((p) => {
              const open = openPb === p.id;
              return (
                <Card key={p.id} className="p-4">
                  <button
                    className="w-full text-left"
                    onClick={() => setOpenPb(open ? null : p.id)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge s={p.severity} />
                      <Badge variant="outline">{p.os}</Badge>
                      <span className="font-medium">{p.title}</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{p.symptom}</p>
                  </button>

                  {open && (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-md border border-border p-3 text-sm">
                        <span className="font-medium">First check: </span>
                        <span className="text-muted-foreground">{p.firstCheck}</span>
                      </div>

                      <ol className="space-y-3">
                        {p.steps.map((s, i) => (
                          <li key={i} className="text-sm">
                            <div className="flex gap-2">
                              <span className="text-muted-foreground">{i + 1}.</span>
                              <div className="flex-1">
                                <p>{s.do}</p>
                                {s.why && <p className="mt-1 text-muted-foreground">Why: {s.why}</p>}
                                {s.cmd && (
                                  <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                                    <code>{s.cmd}</code>
                                  </pre>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>

                      {p.danger && (
                        <div className="rounded-md border border-destructive/40 p-3 text-sm">
                          <p className="font-medium text-destructive">Do not:</p>
                          <ul className="mt-1 space-y-1 text-muted-foreground">
                            {p.danger.map((d) => <li key={d}>• {d}</li>)}
                          </ul>
                        </div>
                      )}

                      <Button
                        variant="outline"
                        className="min-h-11"
                        onClick={() => {
                          setTab("consult");
                          void runConsult(
                            `I'm working through the "${p.title}" playbook on my rig. Symptom: ${p.symptom}. Walk me through it for my exact hardware and ask me for the one measurement or output you need next.`,
                          );
                        }}
                      >
                        Work this with Jackie
                      </Button>
                    </div>
                  )}
                </Card>
              );
            })}

            <Card className="p-4">
              <h3 className="font-medium">Flashing rules — read before any firmware update</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {FLASH_RULES.map((r) => <li key={r}>• {r}</li>)}
              </ul>
            </Card>
          </section>
        )}

        {tab === "firmware" && (
          <section className="space-y-4">
            <Card className="p-4 text-sm text-muted-foreground">
              You log the versions you actually see. Jackie reviews the changelog and the risk — she never
              claims a version number you didn't give her. Everything here stays on this device.
            </Card>

            {RIG.filter((c) => c.firmwareSource).map((c) => {
              const row = firmware.find((r) => r.componentId === c.id);
              return (
                <Card key={c.id} className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{c.name}</h3>
                    <a
                      href={c.firmwareSource!.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="min-h-11 text-sm underline underline-offset-4"
                    >
                      Official source ↗
                    </a>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">
                      <span className="text-muted-foreground">Installed version</span>
                      <Input
                        className="mt-1 min-h-11"
                        value={row?.currentVersion ?? ""}
                        onChange={(e) =>
                          upsertFirmware(c.id, {
                            currentVersion: e.target.value,
                            checkedAt: new Date().toISOString(),
                          })
                        }
                        placeholder="e.g. 7D30v1D / 5B2QGXA7"
                      />
                    </label>
                    <label className="text-sm">
                      <span className="text-muted-foreground">Latest on vendor page</span>
                      <Input
                        className="mt-1 min-h-11"
                        value={row?.latestSeen ?? ""}
                        onChange={(e) =>
                          upsertFirmware(c.id, {
                            latestSeen: e.target.value,
                            checkedAt: new Date().toISOString(),
                          })
                        }
                        placeholder="what the vendor page shows today"
                      />
                    </label>
                  </div>

                  <Textarea
                    className="mt-3"
                    rows={2}
                    placeholder="Note — what problem you're trying to fix, or paste the changelog line"
                    value={row?.note ?? ""}
                    onChange={(e) => upsertFirmware(c.id, { note: e.target.value })}
                  />

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {(["current", "update-available", "flashed", "unknown"] as const).map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant={row?.status === s ? "default" : "outline"}
                        className="min-h-11"
                        onClick={() => upsertFirmware(c.id, { status: s })}
                      >
                        {s}
                      </Button>
                    ))}
                    <Button
                      size="sm"
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => reviewFirmware(c.id)}
                    >
                      {busy ? "Reviewing…" : "Jackie: review this update"}
                    </Button>
                  </div>

                  {row?.checkedAt && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Last logged {new Date(row.checkedAt).toLocaleString()}
                    </p>
                  )}
                </Card>
              );
            })}

            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => exportJson("jackie-firmware-log.json", { rig: RIG_NAME, firmware })}
            >
              Export firmware log (JSON)
            </Button>
          </section>
        )}

        {tab === "toolkit" && (
          <section className="space-y-6">
            <Card className="p-4 text-sm text-muted-foreground">
              Local runners, models that actually fit a 3090, and the repair/update managers worth trusting.
              Commands are real — copy them into Windows Terminal (Admin). Nothing here installs itself.
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Claims checked against your hardware</h3>
              <ul className="mt-3 space-y-3 text-sm">
                {CORRECTIONS.map((c) => (
                  <li key={c.claim}>
                    <p className="text-muted-foreground line-through decoration-destructive/60">{c.claim}</p>
                    <p className="mt-1">{c.reality}</p>
                  </li>
                ))}
              </ul>
            </Card>

            {TOOLKIT.map((group) => (
              <div key={group.id} className="space-y-3">
                <div>
                  <h2 className="font-medium">{group.title}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">{group.intro}</p>
                </div>

                {group.tools.map((t) => (
                  <Card key={t.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <h3 className="font-medium">{t.name}</h3>
                      <Badge variant={t.cost === "paid" ? "destructive" : t.cost === "free" ? "secondary" : "default"}>
                        {t.cost}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{t.what}</p>
                    {t.fit && <p className="mt-2 text-sm">Fit: {t.fit}</p>}
                    {t.caution && (
                      <p className="mt-2 text-sm text-destructive">Caution: {t.caution}</p>
                    )}
                    {t.cmds && (
                      <div className="mt-3 space-y-2">
                        {t.cmds.map((c) => (
                          <div key={c} className="flex items-start gap-2">
                            <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-2 text-xs">{c}</pre>
                            <Button
                              size="sm"
                              variant="outline"
                              className="min-h-11"
                              onClick={() => {
                                navigator.clipboard.writeText(c);
                                toast.success("Command copied");
                              }}
                            >
                              Copy
                            </Button>
                          </div>
                        ))}
                      </div>
                    )}
                    {t.url && (
                      <a
                        href={t.url}
                        target={t.url.startsWith("/") ? undefined : "_blank"}
                        rel="noreferrer noopener"
                        className="mt-3 inline-block min-h-11 text-sm underline underline-offset-4"
                      >
                        {t.url.startsWith("/") ? "Open in Jackie" : "Official source ↗"}
                      </a>
                    )}
                  </Card>
                ))}
              </div>
            ))}
          </section>
        )}



        {tab === "capture" && (
          <section className="space-y-4">
            <Card className="p-4 text-sm text-muted-foreground">
              The clipboard is one slot and it dies with the window. Paste agent context, terminal output or
              error text here before you switch tools — it persists on this device and the consultant reads
              your two most recent captures automatically.
            </Card>

            <Card className="p-4 space-y-3">
              <Input
                className="min-h-11"
                placeholder="Title (optional) — e.g. hermes router session"
                value={capTitle}
                onChange={(e) => setCapTitle(e.target.value)}
              />
              <Textarea
                rows={8}
                placeholder="Paste the context you don't want to lose…"
                value={capBody}
                onChange={(e) => setCapBody(e.target.value)}
              />
              <Button className="min-h-11" onClick={addCapture} disabled={!capBody.trim()}>
                Save capture
              </Button>
            </Card>

            {captures.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="font-medium">{c.title}</h3>
                    <p className="text-xs text-muted-foreground">
                      {new Date(c.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-11"
                      onClick={() => {
                        setTab("consult");
                        runConsult(`Here is context from a session I saved. Tell me what state my system is in and the next concrete step.\n\n${c.body.slice(0, 6000)}`);
                      }}
                    >
                      Hand to Jackie
                    </Button>
                    <Button size="sm" variant="outline" className="min-h-11" onClick={() => removeCapture(c.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">
                  {c.body}
                </pre>
              </Card>
            ))}

            {captures.length > 0 && (
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => exportJson("jackie-session-captures.json", captures)}
              >
                Export captures (JSON)
              </Button>
            )}
          </section>
        )}

        {tab === "consult" && (
          <section className="space-y-4">
            <Card className="p-4 space-y-3">
              <Textarea
                rows={5}
                placeholder="Describe the symptom, paste the error, or ask about a change you're planning…"
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11" onClick={() => runConsult()} disabled={busy || !ask.trim()}>
                  {busy ? "Thinking…" : "Ask the repair crew"}
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() =>
                    runConsult(
                      "Run a full health triage on my rig. Give me the ordered checklist of measurements to take right now (temps, pump RPM, SMART, firmware) and what number would mean trouble for each.",
                    )
                  }
                  disabled={busy}
                >
                  Full health triage
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() =>
                    runConsult(
                      "My Windows admin terminal stopped accepting commands after I switched users while an AI agent was running in it. Diagnose it in order, cheapest check first, with the exact commands.",
                    )
                  }
                  disabled={busy}
                >
                  Terminal not responding
                </Button>
              </div>
              {modelUsed && (
                <p className="text-xs text-muted-foreground">Answered by {modelUsed}</p>
              )}
            </Card>

            {answer && (
              <Card className="p-4">
                <pre className="whitespace-pre-wrap text-sm leading-relaxed">{answer}</pre>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 min-h-11"
                  onClick={() => {
                    navigator.clipboard.writeText(answer);
                    toast.success("Copied");
                  }}
                >
                  Copy answer
                </Button>
              </Card>
            )}

            <Card className="p-4 text-sm text-muted-foreground">
              Jackie advises and verifies. She cannot flash firmware, format a disk or touch the hardware from
              here — your hands do that, with her walking each step.
            </Card>
          </section>
        )}
      </main>
    </div>
  );
}
