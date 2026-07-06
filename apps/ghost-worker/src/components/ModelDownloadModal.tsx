import { CheckCircle2, Download, Loader2, X, XCircle } from "lucide-react";
import type { CatalogModel, ModelDownloadJob } from "../types";

export type DownloadPhase = "preparing" | "downloading" | "completed" | "failed";

interface ModelDownloadModalProps {
  model: CatalogModel | null;
  phase: DownloadPhase;
  progress: number;
  message: string;
  bytesDone?: number;
  bytesTotal?: number;
  speedBps?: number;
  error?: string | null;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i += 1;
  }
  const digits = i >= 2 ? 1 : 0;
  return `${n.toFixed(digits)} ${units[i]}`;
}

function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function phaseTitle(phase: DownloadPhase, failed: boolean): string {
  if (failed) return "Download failed";
  if (phase === "completed") return "Download complete";
  if (phase === "preparing") return "Preparing download";
  return "Downloading model";
}

export function ModelDownloadModal({
  model,
  phase,
  progress,
  message,
  bytesDone = 0,
  bytesTotal = 0,
  speedBps = 0,
  error,
  onClose,
}: ModelDownloadModalProps) {
  if (!model) return null;

  const busy = phase === "preparing" || phase === "downloading";
  const failed = phase === "failed";
  const done = phase === "completed";
  const showTransferStats = busy && (bytesTotal > 0 || bytesDone > 0);
  const speedLabel = formatSpeed(speedBps);

  return (
    <div
      className="operator-modal-veil"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="operator-modal card fade-in model-download-modal"
        role="dialog"
        aria-labelledby="model-download-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="card-pad">
          <div className="operator-modal__head">
            <div className="operator-modal__intro">
              <p className="kicker">// {model.backend} · {model.size_gb} GB</p>
              <h3 id="model-download-title" className="panel-title">
                {phaseTitle(phase, failed)}
              </h3>
              <p className="panel-desc operator-modal__desc">{model.name}</p>
              <p className="kicker mono mt-2">{model.id}</p>
            </div>
            <button
              type="button"
              className="ic-btn operator-modal__close"
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={16} strokeWidth={2} />
            </button>
          </div>

          <div className="model-download-modal__body mt-4">
            <div className="model-download-modal__icon">
              {busy && <Loader2 size={28} className="spin" />}
              {done && <CheckCircle2 size={28} strokeWidth={1.75} />}
              {failed && <XCircle size={28} strokeWidth={1.75} />}
              {!busy && !done && !failed && <Download size={28} strokeWidth={1.75} />}
            </div>

            <div className="row-between mt-4">
              <span className="kicker">{message || "Please wait…"}</span>
              <span className="kicker mono">{Math.round(progress)}%</span>
            </div>
            <div className="bar mt-3">
              <span
                style={{
                  width: `${Math.max(busy && progress === 0 ? 4 : progress, done ? 100 : 0)}%`,
                }}
              />
            </div>

            {showTransferStats && (
              <p className="model-download-modal__stats kicker mono mt-2">
                {formatBytes(bytesDone)} / {formatBytes(bytesTotal)}
                {speedLabel && <span className="model-download-modal__speed"> · {speedLabel}</span>}
              </p>
            )}

            {done && bytesTotal > 0 && (
              <p className="model-download-modal__stats kicker mono mt-2">
                {formatBytes(bytesTotal)} downloaded
              </p>
            )}

            {error && <p className="operator-modal__error mt-3">{error}</p>}

            {busy && (
              <p className="panel-desc mt-3">
                Keep this window open until the download finishes. Large models can take
                several minutes depending on your connection.
              </p>
            )}

            {done && (
              <p className="panel-desc mt-3">
                Weights are ready locally. Click &quot;Use model&quot; on the catalog row
                to activate this model for inference.
              </p>
            )}
          </div>

          <div className="operator-modal__actions mt-4">
            {!busy && (
              <button type="button" className="chip active" onClick={onClose}>
                {done ? "Done" : failed ? "Close" : "Cancel"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function jobToPhase(job: ModelDownloadJob | null): DownloadPhase {
  if (!job) return "preparing";
  if (job.status === "failed") return "failed";
  if (job.status === "completed") return "completed";
  if (job.status === "queued") return "preparing";
  return "downloading";
}
