export const ORCHESTRATOR_PORT = parseInt(process.env.ORCHESTRATOR_PORT ?? '3001', 10);
export const SUPABASE_URL      = process.env.SUPABASE_URL ?? '';
export const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE ?? '';
export const MAX_WORKERS_PER_IP    = 3;
export const MAX_WORKERS_PER_PUBKEY = 5;
export const CANARY_RATE           = 0.05;  // 5% of jobs are canary checks
export const JOB_TIMEOUT_MS        = 120_000;
export const WORKER_IDLE_TIMEOUT_MS = 300_000;
/** Mark worker offline in registry after this long without heartbeat (Gridlock: 120s). */
export const WORKER_AUTOGATE_MS     = 120_000;
