import { Guarantee, JobStatus, WorkerStatus, TeeType, WorkerCapabilities, ChatMessage, ToolDefinition } from './types.js';

// Worker registration
export interface WorkerRegisterDTO {
  pubkey: string;
  auth_token: string;
  model: string;
  tok_per_sec: number;
  capabilities: WorkerCapabilities;
  /** X25519 enclave public key (hex) clients seal payloads to (P2). */
  enclave_pubkey?: string;
}

export interface WorkerRegisterResponseDTO {
  worker_id: string;
  session_token: string;
}

// Job submission
export interface JobSubmitDTO {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  think?: boolean;
  model?: string;
  guarantee: Guarantee;
  max_tokens?: number;
  stream?: boolean;
  x402_receipt?: string;
}

export interface JobSubmitResponseDTO {
  job_id: string;
  status: JobStatus;
  estimated_wait_ms?: number;
}

// Job routing (orchestrator → worker)
export interface JobRouteDTO {
  job_id: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  think: boolean;
  model: string;
  guarantee: Guarantee;
}

// Job completion (worker → orchestrator)
export interface JobCompleteDTO {
  job_id: string;
  response: string;
  tokens_generated: number;
  toploc?: string;
}

// Worker heartbeat
export interface WorkerHeartbeatDTO {
  worker_id: string;
  status: WorkerStatus;
  jobs_completed: number;
  tok_per_sec: number;
}

// Dark pool
export interface OrderSubmitDTO {
  side: 'buy' | 'sell';
  base_mint: string;
  quote_mint: string;
  amount: string;
  price: string;
  guarantee: Guarantee;
  zk_proof?: string;
}

export interface OrderMatchDTO {
  match_id: string;
  buy_order_id: string;
  sell_order_id: string;
  fill_amount: string;
  fill_price: string;
  jito_bundle_id?: string;
}

// Fleet KPIs
export interface FleetStatsDTO {
  active_workers: number;
  total_jobs_24h: number;
  avg_tok_per_sec: number;
  total_ghst_paid_24h: string;
  p50_latency_ms: number;
  p99_latency_ms: number;
}

// Worker payout
export interface PayoutRequestDTO {
  worker_pubkey: string;
  amount_lamports: string;
  signature: string;
}
