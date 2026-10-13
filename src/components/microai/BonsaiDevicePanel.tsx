/**
 * The on-device engine's model shelf: download Bonsai, watch it arrive, remove it.
 *
 * Shown above the composer while On-device is the chosen engine. Everything a
 * person needs to decide is on it before the 237 MB leaves anywhere — the size,
 * where it is stored, and whether this browser will run it on a GPU or will
 * take minutes per first answer on the CPU — because a model that downloads and
 * then crawls, with nothing having said so, reads as a broken feature.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import {
  BONSAI_MB,
  bonsaiDownloadInProgress,
  bonsaiStatus,
  downloadBonsai,
  removeBonsai,
  stopBonsaiDownload,
  UNSUPPORTED_BROWSER,
  type BonsaiStatus,
} from "@/lib/microai/bonsaiDevice";

const mb = (bytes: number) => Math.round(bytes / (1024 * 1024));

export function BonsaiDevicePanel() {
  const [status, setStatus] = useState<BonsaiStatus | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The download belongs to bonsaiDevice.ts, not to this panel, so switching
  // engine mid-download leaves it running; this only stops listening.
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    const next = await bonsaiStatus();
    if (mounted.current) setStatus(next);
  }, []);

  const follow = useCallback(async () => {
    setNote(null);
    const result = await downloadBonsai({ onProgress: (p) => mounted.current && setProgress(p) });
    if (!mounted.current) return;
    setProgress(null);
    setNote(result.ok ? `Downloaded from ${result.from}. Bonsai answers from this tab now.` : result.error);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    // Back on this engine while a download runs: show it, rather than a
    // Download button that would start the same 237 MB again.
    if (bonsaiDownloadInProgress()) void follow();
    return () => {
      mounted.current = false;
    };
  }, [refresh, follow]);

  const remove = async () => {
    setConfirmRemove(false);
    const result = await removeBonsai();
    setNote(result.ok ? `Removed. ${BONSAI_MB} MB freed.` : result.error);
    await refresh();
  };

  const button =
    "rounded-sm border border-border px-2 py-1 font-mono text-[10px] text-foreground hover:bg-secondary transition-colors disabled:opacity-50";

  if (!status) {
    return <div className="mb-2 font-mono text-[10px] text-muted-foreground">Checking this browser for Bonsai…</div>;
  }

  return (
    <div className="mb-2 rounded-sm border border-border p-2 font-mono text-[10px] text-muted-foreground" role="region" aria-label="On-device model">
      {!status.supported ? (
        <p>{UNSUPPORTED_BROWSER}</p>
      ) : progress ? (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="flex-1">
              Downloading Bonsai 1.7B — {mb(progress.loaded)} of {progress.total ? mb(progress.total) : BONSAI_MB} MB
            </span>
            <button className={button} onClick={stopBonsaiDownload}>
              Stop
            </button>
          </div>
          <p>It keeps going if you switch engine; come back here to see it finish.</p>
          <Progress
            className="h-1.5"
            value={progress.total ? (progress.loaded / progress.total) * 100 : 0}
            aria-label="Download progress"
          />
        </div>
      ) : status.downloaded ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1">
            <span className="text-primary">●</span> Bonsai 1.7B is on this device ·{" "}
            {status.gpu ? "runs on the GPU (WebGPU)" : "no WebGPU here, so it runs on the CPU: a first answer can take minutes"}
          </span>
          {confirmRemove ? (
            <>
              <button className={button} onClick={remove}>
                Remove {BONSAI_MB} MB
              </button>
              <button className={button} onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </>
          ) : (
            <button className={button} onClick={() => setConfirmRemove(true)}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-1">
          <p>
            {status.partial
              ? "An incomplete copy of Bonsai is stored here. Download again to replace it, or remove it."
              : `Bonsai 1.7B runs in this tab once it is downloaded: ${BONSAI_MB} MB, once, kept in this browser. No AI provider sees what you ask it; the chat is still saved to your history, as with every engine.`}
          </p>
          {!status.gpu && (
            <p>This browser has no WebGPU, so Bonsai would run on the CPU — expect minutes, not seconds, for a first answer.</p>
          )}
          <div className="flex gap-2">
            <button className={button} onClick={follow}>
              Download ({BONSAI_MB} MB)
            </button>
            {status.partial && (
              <button className={button} onClick={remove}>
                Remove
              </button>
            )}
          </div>
        </div>
      )}
      {status.error && <p className="mt-1 text-destructive">{status.error}</p>}
      {note && <p className="mt-1" role="status">{note}</p>}
    </div>
  );
}
