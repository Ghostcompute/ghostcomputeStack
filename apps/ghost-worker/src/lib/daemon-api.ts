import { isTauri } from "@tauri-apps/api/core";
import { resolveOperatorAddress } from "./operator-address.js";
import type { WorkerGpu, WorkerStatus, ActiveJob, ModelCatalogResponse, ModelDownloadJob, RecentJob } from "../types";

/** Resolve daemon base URL at call time (Tauri dev webview needs Vite proxy or CORS). */
export function getDaemonApi(): string {
  if (typeof window !== "undefined") {
    const { hostname, port } = window.location;
    if (
      (hostname === "localhost" || hostname === "127.0.0.1") &&
      port === "1420"
    ) {
      return "/daemon-api";
    }
  }
  return isTauri() ? "http://127.0.0.1:7421" : "/daemon-api";
}

function normalizeActiveJob(raw: unknown): ActiveJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = raw as Record<string, unknown>;
  const id = job.id;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    tokens: typeof job.tokens === "number" ? job.tokens : undefined,
    guarantee: typeof job.guarantee === "string" ? job.guarantee : undefined,
    progress: typeof job.progress === "number" ? job.progress : undefined,
  };
}

function numField(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeGpu(raw: Record<string, unknown> | null | undefined): WorkerGpu | null {
  if (!raw) return null;
  return {
    name: String(raw.name ?? "Unknown GPU"),
    vram_gb: numField(raw.vram_total_gb ?? raw.vram_gb),
    vram_used_gb: numField(raw.vram_used_gb),
    utilization_pct: numField(raw.utilization ?? raw.utilization_pct),
    temperature_c: numField(raw.temperature ?? raw.temperature_c),
    power_w: numField(raw.power_w),
    power_max_w: numField(raw.power_max_w),
    vendor: raw.vendor as string | undefined,
    pci_slot: raw.pci_slot as string | undefined,
    driver: raw.driver as string | undefined,
    source: raw.source as string | undefined,
    stats_available: Boolean(raw.stats_available),
  };
}

function normalizeStatus(data: Record<string, unknown>): WorkerStatus {
  const gpuRaw = data.gpu as Record<string, unknown> | undefined;
  return {
    running: Boolean(data.running),
    backend_ok: Boolean(data.backend_ok),
    last_backend_error: data.last_backend_error as string | null | undefined,
    worker_address: resolveOperatorAddress(data.worker_address as string | undefined),
    tee_capable: Boolean(data.tee_capable),
    tee_type: data.tee_type as string | undefined,
    compute_mode: data.compute_mode as string | undefined,
    effective_compute: data.effective_compute as string | undefined,
    gpu: normalizeGpu(gpuRaw),
    gpu_detected: Boolean(data.gpu_detected),
    active_job: normalizeActiveJob(data.active_job),
    tokens_per_sec: Number(data.tokens_per_sec ?? 0) || undefined,
    jobs_today: Number(data.jobs_today ?? 0) || undefined,
    earnings_today: Number(data.earnings_today ?? 0) || undefined,
    inference_ready: Boolean(data.inference_ready),
    inference_error: data.inference_error as string | null | undefined,
    inference_backend: data.inference_backend as string | null | undefined,
    ollama_status: data.ollama_status as string | null | undefined,
    ollama_message: data.ollama_message as string | null | undefined,
    active_model: data.active_model as string | null | undefined,
    selected_model: data.selected_model as string | null | undefined,
    selected_backend: data.selected_backend as string | null | undefined,
  };
}

export async function fetchWorkerStatus(): Promise<WorkerStatus | null> {
  try {
    const res = await fetch(`${getDaemonApi()}/status`);
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    return normalizeStatus(data);
  } catch {
    return null;
  }
}

export async function fetchRecentJobs(): Promise<RecentJob[]> {
  try {
    const res = await fetch(`${getDaemonApi()}/jobs`);
    if (!res.ok) return [];
    const data = (await res.json()) as { jobs?: unknown[] };
    if (!Array.isArray(data.jobs)) return [];
    return data.jobs
      .map((raw) => {
        if (!raw || typeof raw !== "object") return null;
        const job = raw as Record<string, unknown>;
        const id = job.id;
        if (typeof id !== "string" || !id) return null;
        return {
          id,
          status: typeof job.status === "string" ? job.status : "unknown",
          tokens: typeof job.tokens === "number" ? job.tokens : undefined,
          earn: typeof job.earn === "number" ? job.earn : undefined,
        } satisfies RecentJob;
      })
      .filter((job): job is RecentJob => job != null);
  } catch {
    return [];
  }
}

export async function clearOperatorWallet(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${getDaemonApi()}/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "" }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!res.ok || body.ok === false) {
      return { ok: false, error: body.error ?? `Request failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Daemon unreachable",
    };
  }
}

export async function setOperatorWallet(address: string): Promise<{
  ok: boolean;
  worker_address?: string;
  message?: string | null;
  error?: string;
}> {
  try {
    const res = await fetch(`${getDaemonApi()}/wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: address.trim() }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      worker_address?: string;
      message?: string | null;
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: body.error ?? body.message ?? `Request failed (${res.status})`,
      };
    }
    if (!body.ok) {
      return {
        ok: false,
        worker_address: body.worker_address,
        message: body.message,
        error: body.message ?? "Orchestrator registration failed",
      };
    }
    return {
      ok: true,
      worker_address: body.worker_address,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Daemon unreachable",
    };
  }
}

export async function fetchModelCatalog(): Promise<ModelCatalogResponse | null> {
  try {
    const res = await fetch(`${getDaemonApi()}/models/catalog`);
    if (!res.ok) return null;
    return (await res.json()) as ModelCatalogResponse;
  } catch {
    return null;
  }
}

export async function downloadModel(modelId: string): Promise<{
  ok: boolean;
  job_id?: string;
  error?: string;
  message?: string;
}> {
  try {
    const res = await fetch(`${getDaemonApi()}/models/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: modelId }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      job_id?: string;
      error?: string;
      message?: string;
    };
    if (!res.ok || body.ok === false) {
      return {
        ok: false,
        error: body.error ?? body.message ?? `Download failed (${res.status})`,
        message: body.message,
      };
    }
    return { ok: true, job_id: body.job_id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Daemon unreachable",
    };
  }
}

export async function fetchDownloadStatus(jobId: string): Promise<ModelDownloadJob | null> {
  try {
    const res = await fetch(
      `${getDaemonApi()}/models/download-status?job_id=${encodeURIComponent(jobId)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as ModelDownloadJob;
  } catch {
    return null;
  }
}

export async function selectModel(
  modelId: string,
  backend?: string,
): Promise<{
  ok: boolean;
  needs_vllm_restart?: boolean;
  error?: string;
  message?: string;
}> {
  try {
    const res = await fetch(`${getDaemonApi()}/models/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: modelId, backend }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      needs_vllm_restart?: boolean;
      error?: string;
      message?: string;
    };
    if (!res.ok || body.ok === false) {
      return {
        ok: false,
        error: body.error ?? body.message ?? `Select failed (${res.status})`,
        message: body.message,
      };
    }
    return { ok: true, needs_vllm_restart: body.needs_vllm_restart };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Daemon unreachable",
    };
  }
}
