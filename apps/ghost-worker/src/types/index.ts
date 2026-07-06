export type TabId = "overview" | "hardware" | "models" | "about";

export type ModelCompatibility = "fits" | "tight" | "no" | "unknown";
export type ModelBackend = "ollama" | "vllm";

export interface CatalogModel {
  id: string;
  name: string;
  backend: ModelBackend;
  size_gb: number;
  min_vram_gb: number;
  params_b?: number;
  quantization?: string;
  tags?: string[];
  description?: string;
  compatibility: ModelCompatibility;
  installed: boolean;
  active: boolean;
}

export interface ModelCatalogResponse {
  models: CatalogModel[];
  vram_gb: number;
  gpu_name?: string;
  selection: { id: string | null; backend: string | null };
}

export interface ModelDownloadJob {
  id: string;
  model_id: string;
  backend?: string;
  status: "queued" | "downloading" | "completed" | "failed";
  progress: number;
  message?: string;
  error?: string | null;
  bytes_done?: number;
  bytes_total?: number;
  speed_bps?: number;
}

export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  healthy: boolean;
  port: number;
  mode: string | null;
  error: string | null;
}

export interface VllmStatus {
  running: boolean;
  pid: number | null;
  healthy: boolean;
  port: number;
  mode: string | null;
  model: string;
  error: string | null;
}

export interface WorkerGpu {
  name?: string;
  vram_gb?: number;
  vram_used_gb?: number;
  utilization_pct?: number;
  temperature_c?: number;
  power_w?: number;
  power_max_w?: number;
  vendor?: string;
  pci_slot?: string;
  driver?: string;
  source?: string;
  stats_available?: boolean;
}

export interface ActiveJob {
  id: string;
  tokens?: number;
  guarantee?: string;
  progress?: number;
}

export interface WorkerStatus {
  running: boolean;
  backend_ok: boolean;
  last_backend_error?: string | null;
  worker_address?: string | null;
  tee_capable?: boolean;
  tee_type?: string;
  compute_mode?: string;
  effective_compute?: string;
  gpu?: WorkerGpu | null;
  gpu_detected?: boolean;
  active_job?: ActiveJob | null;
  tokens_per_sec?: number;
  jobs_today?: number;
  earnings_today?: number;
  inference_ready?: boolean;
  inference_error?: string | null;
  inference_backend?: string | null;
  ollama_status?: string | null;
  ollama_message?: string | null;
  active_model?: string | null;
  selected_model?: string | null;
  selected_backend?: string | null;
}

export interface RecentJob {
  id: string;
  status: string;
  tokens?: number;
  earn?: number;
}
