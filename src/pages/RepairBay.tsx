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
  FIRMWARE_TARGETS, FLASH_SEQUENCE, SEQUENCE_RULES, CADENCE_LABEL, targetsBrief,
  type Cadence,
} from "@/lib/repair/firmwareTargets";
import {
  REPORT_SOURCE,
  REPORTED_SYSTEM,
  REPORTED_GRAPHICS,
  REPORTED_AUDIO,
  REPORTED_NETWORK,
  REPORTED_STORAGE,
  DISCREPANCIES,
  FILL_UNKNOWNS,
  PRIORITY_READ,
  detectedBrief,
} from "@/lib/repair/detectedInventory";

import {
  loadDraft, saveDraft, clearDraft, registerContextSource, guardSwitch,
} from "@/lib/repair/contextGuard";
import { orchestrate } from "@/lib/jackie-orchestrator";

type Tab =
  | "detected"
  | "evidence"
  | "rig"
  | "playbooks"
  | "toolkit"
  | "firmware"
  | "risk"
  | "bootstick"
  | "capture"
  | "consult";

const TABS: { id: Tab; label: string }[] = [
  { id: "detected", label: "Detected Inventory" },
  { id: "evidence", label: "Evidence Log" },
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

${detectedBrief()}


Update/firmware targets on this machine, with the verified rules for each:

${targetsBrief()}

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

const VERDICT_VARIANT: Record<Verdict, "default" | "secondary" | "destructive" | "outline"> = {
  "flash-now": "default",
  "flash-when-calm": "secondary",
  postpone: "outline",
  never: "destructive",
  unknown: "outline",
};

const CADENCE_VARIANT: Record<Cadence, "default" | "secondary" | "destructive" | "outline"> = {
  "safe-anytime": "default",
  "read-notes-first": "secondary",
  "only-for-a-named-fix": "outline",
  "never-unsolicited": "destructive",
};

function loadChecklist(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(CHECKLIST_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export default function RepairBay() {
  const [tab, setTab] = useState<Tab>("detected");
  const [query, setQuery] = useState("");
  const [openPb, setOpenPb] = useState<string | null>(PLAYBOOKS[0]?.id ?? null);

  const [firmware, setFirmware] = useState<FirmwareEntry[]>([]);
  const [captures, setCaptures] = useState<SessionCapture[]>([]);
  const [capTitle, setCapTitle] = useState("");
  const [capBody, setCapBody] = useState("");
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [openStep, setOpenStep] = useState<string | null>(VENTOY_STEPS[0]?.id ?? null);

  const [ask, setAsk] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelUsed, setModelUsed] = useState<string | null>(null);

  useEffect(() => {
    setFirmware(loadFirmware());
    setCaptures(loadCaptures());
    setChecklist(loadChecklist());
    const d = loadDraft();
    setCapTitle(d.title);
    setCapBody(d.body);
  }, []);

  // Anything on this page is available to the Context Guard, so a provider or
  // model switch anywhere in Jackie auto-saves it first.
  useEffect(
    () =>
      registerContextSource("repair-bay", () =>
        [
          ask ? `question: ${ask}` : "",
          answer ? `consultant answer (${modelUsed ?? "unknown model"}):\n${answer}` : "",
          capBody ? `capture draft:\n${capBody}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    [ask, answer, modelUsed, capBody],
  );

  // Draft autosave — a refresh or a crash never eats a paste again.
  useEffect(() => {
    if (capTitle || capBody) saveDraft(capTitle, capBody);
  }, [capTitle, capBody]);

  // Pick up captures written automatically by the failover guard.
  useEffect(() => {
    if (tab === "capture") setCaptures(loadCaptures());
  }, [tab]);

  const riskScores = useMemo<RiskScore[]>(() => scoreAll(firmware), [firmware]);

  const toggleCheck = (id: string) => {
    setChecklist((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(CHECKLIST_KEY, JSON.stringify(next));
      } catch { /* storage blocked */ }
      return next;
    });
  };

  const copy = (text: string, label = "Copied") => {
    navigator.clipboard.writeText(text);
    toast.success(label);
  };


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
    clearDraft();
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
        {tab === "detected" && (
          <section className="space-y-4">
            <Card className="p-4">
              <h2 className="font-medium">What the machine actually reported</h2>
              <p className="mt-1 text-sm text-muted-foreground">{REPORT_SOURCE}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Observed data, kept separate from the build sheet. Where the two disagree, the report
                wins for diagnosis and the difference is listed below instead of quietly smoothed over.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    void navigator.clipboard.writeText(detectedBrief());
                    toast.success("Detected inventory copied");
                  }}
                >
                  Copy inventory brief
                </Button>
                <Button
                  className="min-h-11"
                  onClick={() => {
                    setTab("consult");
                    void runConsult(
                      "Here is my machine's actual reported inventory (MS-7D30, Win 11 Home, i9-12900K, 128 GB, one 980 PRO 2TB, ST2000DM008, WD5000AAKX, BIOS/board/OS build all Unknown). Start with the storage discrepancy: tell me exactly what to run and check, in order, to find out where my other NVMe drives and the Crucial 4 TB are.",
                    );
                  }}
                >
                  Work this with Jackie
                </Button>
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Priority read</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {PRIORITY_READ.map((p) => <li key={p}>• {p}</li>)}
              </ul>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Identification</h3>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                {REPORTED_SYSTEM.map((r) => (
                  <div key={r.label} className="rounded-md border border-border p-3 text-sm">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className={r.value === "Unknown" ? "mt-1 text-destructive" : "mt-1"}>{r.value}</dd>
                  </div>
                ))}
              </dl>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Storage as reported</h3>
              <ul className="mt-2 space-y-2 text-sm">
                {REPORTED_STORAGE.map((s) => (
                  <li key={s.model}>
                    <span className="font-medium">{s.model}</span>
                    <span className="block text-muted-foreground">{s.note}</span>
                  </li>
                ))}
              </ul>
            </Card>

            <div className="grid gap-4 sm:grid-cols-3">
              {[
                { title: "Graphics", items: REPORTED_GRAPHICS },
                { title: "Audio", items: REPORTED_AUDIO },
                { title: "Network / I-O", items: REPORTED_NETWORK },
              ].map((g) => (
                <Card key={g.title} className="p-4">
                  <h3 className="font-medium">{g.title}</h3>
                  <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                    {g.items.map((i) => <li key={i}>• {i}</li>)}
                  </ul>
                </Card>
              ))}
            </div>

            <Card className="p-4">
              <h3 className="font-medium">Discrepancies vs the build sheet</h3>
              <div className="mt-3 space-y-3">
                {DISCREPANCIES.map((d) => (
                  <div key={d.id} className="rounded-md border border-border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{d.what}</Badge>
                    </div>
                    <p className="mt-2">
                      Reported: <span className="text-muted-foreground">{d.reported}</span>
                    </p>
                    <p>
                      Expected: <span className="text-muted-foreground">{d.expected}</span>
                    </p>
                    <p className="mt-2 text-muted-foreground">Why: {d.why}</p>
                    <p className="mt-2">Resolve: <span className="text-muted-foreground">{d.resolve}</span></p>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Fill in every "Unknown"</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Run these in an elevated terminal, then log the results in the Firmware Log. Update Risk
                stays blank until a real version string exists — it will not guess one.
              </p>
              <div className="mt-3 space-y-3">
                {FILL_UNKNOWNS.map((f) => (
                  <div key={f.label} className="rounded-md border border-border p-3 text-sm">
                    <p className="font-medium">{f.label}</p>
                    <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                      <code>{f.cmd}</code>
                    </pre>
                    <p className="mt-2 text-muted-foreground">{f.note}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 min-h-11"
                      onClick={() => {
                        void navigator.clipboard.writeText(f.cmd);
                        toast.success("Command copied");
                      }}
                    >
                      Copy command
                    </Button>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Next steps</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="outline" className="min-h-11" onClick={() => setTab("firmware")}>
                  Log versions
                </Button>
                <Button variant="outline" className="min-h-11" onClick={() => setTab("risk")}>
                  Update risk
                </Button>
                <Button variant="outline" className="min-h-11" onClick={() => setTab("playbooks")}>
                  Repair playbooks
                </Button>
              </div>
            </Card>
          </section>
        )}

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

        {tab === "risk" && (
          <section className="space-y-4">
            <Card className="p-4 text-sm text-muted-foreground">
              Scored from what you logged in the Firmware Log, against what the official changelog for that
              part actually contains — plus how recoverable a failed flash is. No version is invented: if a
              row says "Log a version", that is exactly what it needs.
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">The seven update targets on this rig</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Every updatable thing in the machine, with the exact way to read the version you're on, what
                the update actually buys you, and what happens if it fails. Ordered by risk, not by hype.
              </p>

              <div className="mt-4 space-y-3">
                {FIRMWARE_TARGETS.map((t) => (
                  <div key={t.id} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="font-medium">{t.name}</h4>
                        <p className="text-xs text-muted-foreground">{t.kind}</p>
                      </div>
                      <Badge variant={CADENCE_VARIANT[t.cadence]}>{CADENCE_LABEL[t.cadence]}</Badge>
                    </div>

                    <p className="mt-2 text-sm font-medium">Read your version</p>
                    <ul className="mt-1 space-y-1">
                      {t.readVersion.map((cmd) => (
                        <li key={cmd} className="flex items-start gap-2">
                          <code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{cmd}</code>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="min-h-11 shrink-0"
                            onClick={() => {
                              void navigator.clipboard.writeText(cmd);
                              toast.success("Copied");
                            }}
                          >
                            Copy
                          </Button>
                        </li>
                      ))}
                    </ul>

                    <p className="mt-3 text-sm">
                      <span className="font-medium">What it buys you: </span>
                      <span className="text-muted-foreground">{t.gain}</span>
                    </p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">If it fails: </span>
                      <span className="text-muted-foreground">{t.ifItFails}</span>
                    </p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Jackie's rule: </span>
                      <span className="text-muted-foreground">{t.rule}</span>
                    </p>

                    {t.knownBuilds?.map((b) => (
                      <p key={b.version} className="mt-2 rounded border border-border p-2 text-sm">
                        <span className="font-medium">{b.version}</span>{" "}
                        <span className="text-muted-foreground">{b.note}</span>
                      </p>
                    ))}

                    {t.source && (
                      <a
                        href={t.source.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="mt-2 inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                      >
                        {t.source.label} ↗
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h3 className="font-medium">Safe flash sequence</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                When you do a full pass, this is the order. It exists because each step can invalidate the one
                before it.
              </p>
              <ol className="mt-3 space-y-2 text-sm">
                {FLASH_SEQUENCE.map((t, i) => (
                  <li key={t.id} className="flex gap-3">
                    <span className="font-medium">{i + 1}.</span>
                    <span>
                      <span className="font-medium">{t.name}</span>{" "}
                      <span className="text-muted-foreground">— {CADENCE_LABEL[t.cadence]}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-sm text-muted-foreground">
                Not in the sequence: the 3090 VBIOS and the PSU. Neither has a legitimate routine update.
              </p>
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {SEQUENCE_RULES.map((r) => <li key={r}>• {r}</li>)}
              </ul>
              <Button
                variant="outline"
                className="mt-3 min-h-11"
                onClick={() => {
                  void navigator.clipboard.writeText(targetsBrief());
                  toast.success("Full analysis copied");
                }}
              >
                Copy full analysis
              </Button>
            </Card>


            {riskScores.map((r) => (
              <Card key={r.componentId} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Badge variant={VERDICT_VARIANT[r.verdict]}>{VERDICT_LABEL[r.verdict]}</Badge>
                    <h3 className="mt-2 font-medium">{r.componentName}</h3>
                    <p className="mt-1 text-sm">{r.headline}</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <p>Risk {r.risk}/100</p>
                    <p>Benefit {r.benefit}/100</p>
                  </div>
                </div>

                {r.matchedChangelog && (
                  <div className="mt-3 rounded-md border border-border p-3 text-sm">
                    <p className="font-medium">Documented release {r.matchedChangelog.version}</p>
                    <p className="mt-1 text-muted-foreground">{r.matchedChangelog.fixes}</p>
                  </div>
                )}

                <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                  {r.reasons.map((x) => <li key={x}>• {x}</li>)}
                </ul>

                <div className="mt-3 rounded-md border border-border p-3 text-sm">
                  <p><span className="font-medium">Read first: </span><span className="text-muted-foreground">{r.readFirst}</span></p>
                  <p className="mt-2"><span className="font-medium">If the flash fails: </span><span className="text-muted-foreground">{r.recovery}</span></p>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {r.sourceUrl && (
                    <a
                      href={r.sourceUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                    >
                      Official changelog ↗
                    </a>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => reviewFirmware(r.componentId)}
                  >
                    Ask Jackie to review
                  </Button>
                </div>
              </Card>
            ))}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => exportJson("jackie-firmware-risk.json", { rig: RIG_NAME, scored: riskScores })}
              >
                Export risk report (JSON)
              </Button>
              <Button variant="outline" className="min-h-11" onClick={() => setTab("firmware")}>
                Log more versions
              </Button>
            </div>

            <Card className="p-4">
              <h3 className="font-medium">Flashing rules — non-negotiable</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {FLASH_RULES.map((x) => <li key={x}>• {x}</li>)}
              </ul>
            </Card>
          </section>
        )}

        {tab === "bootstick" && (
          <section className="space-y-4">
            <Card className="p-4 text-sm text-muted-foreground">
              Build this while the machine still works. Ventoy holds Win11 + Win10 + Ubuntu + Memtest on one
              stick, and every ISO gets SHA-256 verified before you trust it. Jackie cannot host the images —
              official vendor links and your own checksum check is the honest path.
            </Card>

            {VENTOY_STEPS.map((s) => {
              const open = openStep === s.id;
              return (
                <Card key={s.id} className="p-4">
                  <button className="w-full text-left" onClick={() => setOpenStep(open ? null : s.id)}>
                    <h3 className="font-medium">{s.title}</h3>
                    {!open && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{s.body}</p>}
                  </button>

                  {open && (
                    <div className="mt-3 space-y-3">
                      <p className="text-sm text-muted-foreground">{s.body}</p>

                      {s.warn && (
                        <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
                          {s.warn}
                        </div>
                      )}

                      {s.cmds?.map((c) => (
                        <div key={c.cmd} className="space-y-1">
                          <div className="flex items-start gap-2">
                            <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-3 text-xs">
                              <code>{c.cmd}</code>
                            </pre>
                            <Button size="sm" variant="outline" className="min-h-11" onClick={() => copy(c.cmd, "Command copied")}>
                              Copy
                            </Button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {c.shell}{c.note ? ` — ${c.note}` : ""}
                          </p>
                        </div>
                      ))}

                      {s.links && (
                        <ul className="space-y-1 text-sm">
                          {s.links.map((l) => (
                            <li key={l.url}>
                              <a
                                href={l.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex min-h-11 items-center underline underline-offset-4"
                              >
                                {l.label} ↗
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}

            <Card className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-medium">Emergency stick checklist</h3>
                <span className="text-xs text-muted-foreground">
                  {ISO_CHECKLIST.filter((i) => checklist[i.id]).length}/{ISO_CHECKLIST.length} done
                </span>
              </div>
              <ul className="mt-3 space-y-2">
                {ISO_CHECKLIST.map((i) => (
                  <li key={i.id}>
                    <button
                      onClick={() => toggleCheck(i.id)}
                      className="flex min-h-11 w-full items-start gap-3 text-left text-sm"
                    >
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${checklist[i.id] ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>
                        {checklist[i.id] ? "✓" : ""}
                      </span>
                      <span>
                        <span className={checklist[i.id] ? "line-through text-muted-foreground" : ""}>{i.label}</span>
                        <span className="block text-xs text-muted-foreground">{i.detail}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() =>
                  copy(
                    VENTOY_STEPS.map(
                      (s) =>
                        `## ${s.title}\n${s.body}${s.warn ? `\n! ${s.warn}` : ""}${
                          s.cmds ? `\n${s.cmds.map((c) => `[${c.shell}] ${c.cmd}`).join("\n")}` : ""
                        }${s.links ? `\n${s.links.map((l) => `${l.label}: ${l.url}`).join("\n")}` : ""}`,
                    ).join("\n\n"),
                    "Full wizard copied",
                  )
                }
              >
                Copy the whole wizard
              </Button>
              <Button
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  guardSwitch("manual-checkpoint", { detail: "Boot stick wizard handoff" });
                  setTab("consult");
                  void runConsult(
                    "I'm building the Ventoy emergency boot stick for my rig. Ask me for the outputs you need (disk number, Secure Boot state, BitLocker status) and check my plan step by step, including the Intel RST/VMD driver requirement for my NVMe drives.",
                  );
                }}
              >
                Walk this with Jackie
              </Button>
            </div>
          </section>
        )}

        {tab === "capture" && (

          <section className="space-y-4">
            <Card className="p-4 text-sm text-muted-foreground">
              The clipboard is one slot and it dies with the window. Two things now happen automatically:
              this editor autosaves as you type, and every provider or model switch (including an Ollama
              rate-limit failover) writes an <span className="font-medium">[auto]</span> capture of the live
              context before the switch. Nothing you were working on leaves with the model.
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
              <div className="flex flex-wrap gap-2">
                <Button className="min-h-11" onClick={addCapture} disabled={!capBody.trim()}>
                  Save capture
                </Button>
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={() => {
                    const row = guardSwitch("manual-checkpoint", { detail: "Manual checkpoint from Repair Bay" });
                    setCaptures(loadCaptures());
                    toast[row ? "success" : "error"](
                      row ? "Checkpoint saved on this device." : "Nothing open to checkpoint yet.",
                    );
                  }}
                >
                  Checkpoint everything now
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Draft autosaves locally — a refresh or a crash will not eat this paste.
              </p>
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
