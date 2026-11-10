import { useState } from "react";
import { Button } from "@/components/ui/button";
import { runResilienceSuite, type CheckResult } from "@/lib/offlineResilience";

const MARK = { pass: "✓", warn: "!", fail: "✕" } as const;
const TONE = { pass: "text-primary", warn: "text-muted-foreground", fail: "text-destructive" } as const;

export default function OfflineCheck() {
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setResults(await runResilienceSuite()); } finally { setBusy(false); }
  };
  const ready = results?.every((r) => r.status !== "fail");
  return (
    <main className="mx-auto max-w-2xl p-6 space-y-4">
      <h1 className="text-2xl font-semibold">Offline check</h1>
      <p className="text-muted-foreground">Checks whether Jackie can still answer on this device with no internet.</p>
      <Button className="min-h-11" onClick={run} disabled={busy}>{busy ? "Checking…" : "Run offline check"}</Button>
      {results && (
        <>
          <p className="font-medium">{ready ? "Ready to work offline." : "Not ready for offline yet — fix the ✕ items."}</p>
          <ul className="space-y-2">
            {results.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-3">
                <div className={`font-medium ${TONE[r.status]}`}>{MARK[r.status]} {r.label}</div>
                <div className="text-sm text-muted-foreground">{r.detail}</div>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
