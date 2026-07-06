import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import { Check, Download, HardDrive, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  downloadModel,
  fetchDownloadStatus,
  fetchModelCatalog,
  selectModel,
} from "../lib/daemon-api";
import type { CatalogModel, ModelCatalogResponse, WorkerStatus } from "../types";
import { Card, CardPad, Tag } from "../components/Card";
import { jobToPhase, ModelDownloadModal, type DownloadPhase } from "../components/ModelDownloadModal";

type BackendFilter = "all" | "ollama";
type CompatFilter = "all" | "fits";

interface ModelsPanelProps {
  worker: WorkerStatus | null;
  onRefresh: () => Promise<unknown>;
}

function compatVariant(c: CatalogModel["compatibility"]): "ok" | "warn" | "danger" | "default" {
  if (c === "fits") return "ok";
  if (c === "tight") return "warn";
  if (c === "no") return "danger";
  return "default";
}

function compatLabel(c: CatalogModel["compatibility"]): string {
  if (c === "fits") return "fits GPU";
  if (c === "tight") return "tight fit";
  if (c === "no") return "too large";
  return "unknown VRAM";
}

function filterLabel(f: BackendFilter): string {
  if (f === "all") return "All models";
  return "Ollama";
}

export function ModelsPanel({ worker, onRefresh }: ModelsPanelProps) {
  const [catalog, setCatalog] = useState<ModelCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendFilter, setBackendFilter] = useState<BackendFilter>("all");
  const [compatFilter, setCompatFilter] = useState<CompatFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [downloadModel_, setDownloadModel] = useState<CatalogModel | null>(null);
  const [downloadPhase, setDownloadPhase] = useState<DownloadPhase>("preparing");
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadMessage, setDownloadMessage] = useState("Preparing…");
  const [downloadBytesDone, setDownloadBytesDone] = useState(0);
  const [downloadBytesTotal, setDownloadBytesTotal] = useState(0);
  const [downloadSpeedBps, setDownloadSpeedBps] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadJobId, setDownloadJobId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const workerRunning = Boolean(worker?.running);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  };

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    const data = await fetchModelCatalog();
    setCatalog(data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const closeDownloadModal = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setDownloadModel(null);
    setDownloadJobId(null);
    setDownloadPhase("preparing");
    setDownloadProgress(0);
    setDownloadMessage("Preparing…");
    setDownloadBytesDone(0);
    setDownloadBytesTotal(0);
    setDownloadSpeedBps(0);
    setDownloadError(null);
    setBusyId(null);
  }, []);

  useEffect(() => {
    if (!downloadJobId) return;

    const poll = async () => {
      const status = await fetchDownloadStatus(downloadJobId);
      if (!status) return;

      setDownloadProgress(status.progress ?? 0);
      setDownloadMessage(status.message ?? status.status);
      setDownloadBytesDone(status.bytes_done ?? 0);
      setDownloadBytesTotal(status.bytes_total ?? 0);
      setDownloadSpeedBps(status.speed_bps ?? 0);
      setDownloadPhase(jobToPhase(status));

      if (status.status === "completed") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setBusyId(null);
        await loadCatalog();
      }

      if (status.status === "failed") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setDownloadError(status.error ?? status.message ?? "Download failed");
        setDownloadPhase("failed");
        setBusyId(null);
      }
    };

    void poll();
    pollRef.current = setInterval(() => void poll(), 600);

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [downloadJobId, loadCatalog]);

  const models = useMemo(() => {
    if (!catalog?.models) return [];
    return catalog.models.filter((m) => {
      if (backendFilter !== "all" && m.backend !== backendFilter) return false;
      if (compatFilter === "fits" && m.compatibility !== "fits") return false;
      return true;
    });
  }, [catalog, backendFilter, compatFilter]);

  const handleDownload = async (model: CatalogModel) => {
    if (workerRunning) {
      showToast("Stop the worker before downloading");
      return;
    }

    setDownloadModel(model);
    setDownloadPhase("preparing");
    setDownloadProgress(0);
    setDownloadMessage("Starting download…");
    setDownloadBytesDone(0);
    setDownloadBytesTotal(Math.round(model.size_gb * 1_000_000_000));
    setDownloadSpeedBps(0);
    setDownloadError(null);
    setDownloadJobId(null);
    setBusyId(model.id);

    const result = await downloadModel(model.id);
    if (!result.ok || !result.job_id) {
      setDownloadPhase("failed");
      setDownloadError(result.error ?? result.message ?? "Download failed");
      setBusyId(null);
      return;
    }

    setDownloadJobId(result.job_id);
    setDownloadPhase("downloading");
  };

  const handleSelect = async (model: CatalogModel) => {
    if (workerRunning) {
      showToast("Stop the worker before changing models");
      return;
    }
    if (model.compatibility === "no") {
      showToast("Model needs more VRAM than this GPU");
      return;
    }
    setBusyId(model.id);
    const result = await selectModel(model.id, model.backend);
    if (!result.ok) {
      showToast(result.error ?? result.message ?? "Could not select model");
      setBusyId(null);
      return;
    }
    if (result.needs_vllm_restart && isTauri()) {
      showToast("Restarting vLLM with new model…");
      try {
        await invoke("vllm_restart");
      } catch {
        showToast("Model saved — restart vLLM manually");
      }
    }
    await loadCatalog();
    await onRefresh();
    showToast(`Active model: ${model.name}`);
    setBusyId(null);
  };

  const vramLabel =
    catalog?.vram_gb && catalog.vram_gb > 0
      ? `${catalog.vram_gb} GB VRAM`
      : "VRAM unknown";

  return (
    <div className="models-panel fade-in">
      {toast && <div className="toast">{toast}</div>}

      <ModelDownloadModal
        model={downloadModel_}
        phase={downloadPhase}
        progress={downloadProgress}
        message={downloadMessage}
        bytesDone={downloadBytesDone}
        bytesTotal={downloadBytesTotal}
        speedBps={downloadSpeedBps}
        error={downloadError}
        onClose={closeDownloadModal}
      />

      <div className="models-panel__header grid-2 mt-3">
        <Card>
          <CardPad>
            <p className="kicker">// hardware</p>
            <h3 className="panel-title">Your GPU</h3>
            <p className="panel-desc mt-3">
              {catalog?.gpu_name ?? worker?.gpu?.name ?? "Detecting…"}
            </p>
            <div className="row-between mt-4">
              <Tag variant={catalog?.vram_gb ? "ok" : "warn"}>{vramLabel}</Tag>
              {catalog?.selection?.id && (
                <span className="kicker mono">
                  active · {catalog.selection.backend} ·{" "}
                  {catalog.selection.id.split("/").pop() ?? catalog.selection.id}
                </span>
              )}
            </div>
          </CardPad>
        </Card>
        <Card>
          <CardPad>
            <p className="kicker">// filters</p>
            <h3 className="panel-title">Catalog</h3>
            <div className="model-filters mt-4">
              {(["all", "ollama"] as BackendFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`chip${backendFilter === f ? " active" : ""}`}
                  onClick={() => setBackendFilter(f)}
                >
                  {filterLabel(f)}
                </button>
              ))}
              <button
                type="button"
                className={`chip${compatFilter === "fits" ? " active" : ""}`}
                onClick={() =>
                  setCompatFilter((c) => (c === "fits" ? "all" : "fits"))
                }
              >
                Fits my GPU
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => void loadCatalog()}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 size={12} className="spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Refresh
              </button>
            </div>
            {workerRunning && (
              <p className="panel-desc mt-3" style={{ color: "var(--muted)" }}>
                Worker is running — stop it to download or switch models.
              </p>
            )}
          </CardPad>
        </Card>
      </div>

      <Card className="models-panel__library">
        <CardPad className="models-panel__library-pad">
          <div className="models-panel__library-head row-between">
            <div>
              <p className="kicker">// model library</p>
              <h3 className="panel-title">Available models</h3>
            </div>
            <Tag variant="default">{models.length} shown</Tag>
          </div>

          {loading && !catalog ? (
            <p className="panel-desc mt-4">
              <Loader2 size={14} className="spin" /> Loading catalog…
            </p>
          ) : (
            <div className="model-list models-panel__list mt-4">
              {models.map((model) => {
                const busy = busyId === model.id;
                const downloadingThis =
                  downloadModel_?.id === model.id &&
                  (downloadPhase === "preparing" || downloadPhase === "downloading");
                return (
                  <div
                    key={`${model.backend}:${model.id}`}
                    className={`model-row${model.active ? " model-row--active" : ""}`}
                  >
                    <div className="model-row__main">
                      <div className="row-between">
                        <strong>{model.name}</strong>
                        <div className="model-row__tags">
                          {model.active && <Tag variant="ok">active</Tag>}
                          <Tag variant="default">{model.backend}</Tag>
                          <Tag variant={compatVariant(model.compatibility)}>
                            {compatLabel(model.compatibility)}
                          </Tag>
                          {model.installed && (
                            <Tag variant="ok">
                              <HardDrive size={10} /> local
                            </Tag>
                          )}
                        </div>
                      </div>
                      <p className="panel-desc mt-2">{model.description}</p>
                      <p className="kicker mt-2 mono">{model.id}</p>
                      <div className="model-row__meta mt-2">
                        <span>{model.size_gb} GB download</span>
                        <span>·</span>
                        <span>{model.min_vram_gb} GB min VRAM</span>
                        {model.params_b != null && (
                          <>
                            <span>·</span>
                            <span>{model.params_b}B params</span>
                          </>
                        )}
                        {model.quantization && (
                          <>
                            <span>·</span>
                            <span>{model.quantization}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="model-row__actions">
                      {!model.installed && (
                        <button
                          type="button"
                          className={`chip${busy ? " busy" : ""}`}
                          disabled={busy || workerRunning || downloadingThis}
                          onClick={() => void handleDownload(model)}
                        >
                          {downloadingThis ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Download size={12} />
                          )}
                          Download
                        </button>
                      )}
                      {!model.active && (
                        <button
                          type="button"
                          className={`chip active${busy ? " busy" : ""}`}
                          disabled={
                            busy ||
                            workerRunning ||
                            model.compatibility === "no"
                          }
                          onClick={() => void handleSelect(model)}
                        >
                          {busy && !downloadingThis ? (
                            <Loader2 size={12} className="spin" />
                          ) : (
                            <Check size={12} />
                          )}
                          Use model
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardPad>
      </Card>
    </div>
  );
}
