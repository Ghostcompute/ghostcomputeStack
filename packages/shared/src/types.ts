export enum Guarantee {
  Standard = 'standard',
  High = 'high',
  MaxTrustSplit = 'max_trust_split',
}

export enum JobStatus {
  Pending = 'pending',
  Routing = 'routing',
  Running = 'running',
  Completed = 'completed',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum WorkerStatus {
  Offline = 'offline',
  Idle = 'idle',
  Busy = 'busy',
  Draining = 'draining',
}

export enum TeeType {
  NvidiaCC = 'nvidia_cc',
  AmdSevSnp = 'amd_sev_snp',
  None = 'none',
}

export interface WorkerCapabilities {
  vram_gb: number;
  gpu_model: string;
  tok_per_sec: number;
  tee_type: TeeType;
  supports_vision: boolean;
  supports_tools: boolean;
  supports_thinking: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  tool_name?: string;
}

export interface ToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToplockCommitment {
  model_hash: string;
  input_hash: string;
  output_hash: string;
  commitment_bytes: string;
}

export interface WorkerEarning {
  worker_pubkey: string;
  job_id: string;
  tokens_generated: number;
  ghst_amount_lamports: bigint;
  settled_at: number | null;
}

export interface DarkPoolOrder {
  order_id: string;
  side: 'buy' | 'sell';
  base_mint: string;
  quote_mint: string;
  amount: bigint;
  price: bigint;
  owner_pubkey: string;
  guarantee: Guarantee;
  created_at: number;
}
