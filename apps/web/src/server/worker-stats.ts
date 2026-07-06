/**
 * Worker performance metrics recomputed after each settled job.
 * Adapted from Gridlock's worker-stats.ts — adds TEE scoring and penalty tracking.
 */

import { createClient } from '@supabase/supabase-js';

const WORKER_FEE_SHARE = 0.2; // 20% of job fee goes to worker (see GHST tokenomics)

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

export interface WorkerStats {
  jobs_today: number;
  earnings_today: number;
  penalties_paid: number;
  sla_pass_rate: number;
  p99_ttft_ms: number;
  goodput_score: number;
  reliability_score: number;
}

/** Pull last 24h settled jobs for a worker and recompute all KPIs. */
export async function recomputeWorkerStats(workerId: string): Promise<WorkerStats> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const { data: jobs } = await db
    .from('jobs')
    .select('id, status, tokens_generated, ttft_ms, tpot_ms, sla_met, penalty_paid, fee_ghst, completed_at')
    .eq('worker_id', workerId)
    .eq('status', 'completed')
    .gte('completed_at', dayAgo);

  const settled = jobs ?? [];
  const jobsToday = settled.length;
  const earningsToday = Math.round(
    settled.reduce((s, j) => s + Number(j.fee_ghst ?? 0) * WORKER_FEE_SHARE, 0) * 10_000,
  ) / 10_000;
  const penaltiesPaid = Math.round(
    settled.reduce((s, j) => s + Number(j.penalty_paid ?? 0), 0) * 10_000,
  ) / 10_000;

  const slaMet = settled.filter(j => j.sla_met).length;
  const slaPassRate = settled.length
    ? Math.round((slaMet / settled.length) * 1000) / 10
    : 100;

  const ttfts = settled.map(j => Number(j.ttft_ms ?? 0)).sort((a, b) => a - b);
  const p99Idx = ttfts.length
    ? Math.min(ttfts.length - 1, Math.floor(ttfts.length * 0.99))
    : 0;
  const p99TtftMs = ttfts[p99Idx] ?? 0;

  // goodput_score: jobs in last hour within SLA × 100 (matches Gridlock formula)
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const goodputJobs = settled.filter(
    j => j.sla_met && j.completed_at && j.completed_at >= hourAgo,
  );
  const goodputScore = goodputJobs.length * 100;

  // reliability_score: 0..10000 (sla_pass_rate × 100, capped at 10000)
  const reliabilityScore = Math.min(10_000, Math.round(slaPassRate * 100));

  return {
    jobs_today: jobsToday,
    earnings_today: earningsToday,
    penalties_paid: penaltiesPaid,
    sla_pass_rate: slaPassRate,
    p99_ttft_ms: p99TtftMs,
    goodput_score: goodputScore,
    reliability_score: reliabilityScore,
  };
}

/** Called after a job settles — recomputes and persists worker KPIs. */
export async function onWorkerJobSettled(workerId: string): Promise<void> {
  const stats = await recomputeWorkerStats(workerId);
  await db.from('workers').update({
    jobs_today: stats.jobs_today,
    earnings_today: stats.earnings_today,
    penalties_paid: stats.penalties_paid,
    sla_pass_rate: stats.sla_pass_rate,
    p99_ttft_ms: stats.p99_ttft_ms,
    goodput_score: stats.goodput_score,
    reliability_score: stats.reliability_score,
  }).eq('id', workerId);
}
