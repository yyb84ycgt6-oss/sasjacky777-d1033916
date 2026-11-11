import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Download, RefreshCw, MessageSquare } from "lucide-react";
import { resilienceReport, runResilienceSuite, summarizeChecks, type CheckResult } from "@/lib/offlineResilience";
import { verifyOfflineReply } from "@/lib/offlineReplyCheck";

const MARK = { pass: "✓", warn: "!", fail: "✕" } as const;
const TONE = { pass: "text-primary", warn: "text-muted-foreground", fail: "text-destructive" } as const;

export default function OfflineCheck() {
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [replyBusy, setReplyBusy] = useState(false);
  const [reply, setReply] = useState<CheckResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    setReply(null);
    try { setResults(await runResilienceSuite()); setCheckedAt(new Date().toISOString()); }
    catch { setError("Checks could not finish. Please try again."); }
    finally { setBusy(false); }
  };
  const testReply = async () => {
    setReplyBusy(true);
    try { setReply(await verifyOfflineReply()); setCheckedAt(new Date().toISOString()); }
    finally { setReplyBusy(false); }
  };
  const checks = [...(results ?? []), ...(reply ? [reply] : [])];
  const download = () => {
    if (!checkedAt) return;
    const url = URL.createObjectURL(new Blob([resilienceReport(checks, checkedAt)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "jackie-device-check.json"; link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Offline check</h1>
      <div className="flex flex-wrap gap-3">
        <Button className="min-h-11" onClick={run} disabled={busy || replyBusy}><RefreshCw />{busy ? "Checking…" : "Run offline check"}</Button>
        <Button variant="outline" className="min-h-11" onClick={testReply} disabled={busy || replyBusy}><MessageSquare />{replyBusy ? "Waiting for local reply…" : "Test local reply"}</Button>
        <Button variant="ghost" className="min-h-11" onClick={download} disabled={!checkedAt || busy || replyBusy}><Download />Save report</Button>
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {checkedAt && <p className="text-sm text-muted-foreground">This device · {new Date(checkedAt).toLocaleString()}</p>}
      {results && (
        <>
          <p role="status" className="font-medium">{summarizeChecks(checks)}</p>
        </>
      )}
      {checks.length > 0 && (
          <ul aria-label="Device check results" className="space-y-2">
            {checks.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-3">
                <div className={`font-medium ${TONE[r.status]}`}>{MARK[r.status]} {r.label}</div>
                <div className="text-sm text-muted-foreground">{r.detail}</div>
              </li>
            ))}
          </ul>
      )}
    </main>
  );
}
