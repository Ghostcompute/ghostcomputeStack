import { createClient } from '@supabase/supabase-js';
import type { FleetStatsDTO } from '@ghost-compute/shared';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

export async function getFleetStats(): Promise<FleetStatsDTO> {
  const [workersRes, jobsRes, earningsRes] = await Promise.all([
    db.from('workers').select('status, tok_per_sec'),
    db.from('jobs')
      .select('created_at, started_at, completed_at, tokens_generated')
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
    db.from('worker_earnings')
      .select('ghst_amount_raw')
      .gte('created_at', new Date(Date.now() - 86_400_000).toISOString()),
  ]);

  const workers = workersRes.data ?? [];
  const jobs    = jobsRes.data ?? [];
  const earnings = earningsRes.data ?? [];

  const active = workers.filter(w => w.status === 'idle' || w.status === 'busy');
  const avgTok = active.length
    ? active.reduce((s: number, w: any) => s + (w.tok_per_sec ?? 0), 0) / active.length
    : 0;

  // Latency: time from created_at to completed_at for completed jobs
  const latencies = jobs
    .filter((j: any) => j.completed_at && j.created_at)
    .map((j: any) => new Date(j.completed_at).getTime() - new Date(j.created_at).getTime())
    .sort((a: number, b: number) => a - b);

  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p99 = latencies.length ? latencies[Math.floor(latencies.length * 0.99)] : 0;

  const totalGhst = earnings.reduce((s: bigint, e: any) => s + BigInt(e.ghst_amount_raw ?? 0), 0n);

  return {
    active_workers:      active.length,
    total_jobs_24h:      jobs.length,
    avg_tok_per_sec:     Math.round(avgTok * 10) / 10,
    total_ghst_paid_24h: totalGhst.toString(),
    p50_latency_ms:      p50,
    p99_latency_ms:      p99,
  };
}
