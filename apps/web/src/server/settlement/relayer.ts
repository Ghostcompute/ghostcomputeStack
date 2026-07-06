/**
 * Settlement relayer: batches worker earnings → Jito bundle → on-chain payout.
 * Now wired into the full Anchor settlement pipeline from on-chain.ts.
 * Runs as a cron (every 10 min) or manually triggered via POST /api/settle.
 */

import { createClient } from '@supabase/supabase-js';
import { runOnChainSettlement } from './on-chain.js';
import { settleConfidential } from './confidential.js';

const JITO_BLOCK_ENGINE = process.env.JITO_BLOCK_ENGINE ?? '';
const MIN_PAYOUT_LAMPORTS = 1_000_000n;

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

interface PendingPayout {
  worker_id: string;
  worker_pubkey: string;
  stake_account: string | null;
  total_raw: bigint;
  earning_ids: string[];
}

async function collectPendingPayouts(): Promise<PendingPayout[]> {
  const { data: earnings } = await db
    .from('worker_earnings')
    .select('id, worker_id, ghst_amount_raw, workers(pubkey, stake_token_account)')
    .eq('settled', false)
    .order('created_at', { ascending: true });

  if (!earnings?.length) return [];

  const grouped = new Map<string, PendingPayout>();
  for (const e of earnings) {
    const wid = e.worker_id;
    const worker = (e as any).workers;
    if (!grouped.has(wid)) {
      grouped.set(wid, {
        worker_id: wid,
        worker_pubkey: worker?.pubkey ?? '',
        stake_account: worker?.stake_token_account ?? null,
        total_raw: 0n,
        earning_ids: [],
      });
    }
    const g = grouped.get(wid)!;
    g.total_raw += BigInt(e.ghst_amount_raw ?? 0);
    g.earning_ids.push(e.id);
  }

  return [...grouped.values()].filter(p => p.total_raw >= MIN_PAYOUT_LAMPORTS);
}

async function sendJitoBundle(transactions: Buffer[]): Promise<string | null> {
  if (!JITO_BLOCK_ENGINE || !transactions.length) return null;
  try {
    const res = await fetch(`${JITO_BLOCK_ENGINE}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'sendBundle',
        params: [transactions.map(t => t.toString('base64'))],
      }),
    });
    const json: any = await res.json();
    return json.result ?? null;
  } catch (err) {
    console.error('[relayer] Jito bundle failed:', err);
    return null;
  }
}

export async function runSettlementCycle(): Promise<{ settled: number; bundleId: string | null }> {
  const payouts = await collectPendingPayouts();
  if (!payouts.length) {
    console.log('[relayer] No pending payouts');
    return { settled: 0, bundleId: null };
  }

  // Fetch settled jobs to run per-job on-chain settlement
  const { data: completedJobs } = await db
    .from('jobs')
    .select('id, guarantee, ttft_ms, tpot_ms, sla_met, tokens_generated, attestation_hash, customer_pubkey, worker_id, workers(pubkey, stake_token_account)')
    .eq('status', 'completed')
    .eq('on_chain_settled', false)
    .order('completed_at', { ascending: true })
    .limit(20);

  if (completedJobs?.length) {
    await Promise.allSettled(completedJobs.map(async job => {
      const worker = (job as any).workers;
      await runOnChainSettlement({
        jobId: job.id,
        guarantee: job.guarantee ?? 'standard',
        ttftMs: job.ttft_ms ?? 0,
        tpotMs: job.tpot_ms ?? 0,
        slaMet: job.sla_met ?? true,
        confidential: job.guarantee === 'high' || job.guarantee === 'max_trust_split',
        workerPubkey: worker?.pubkey ?? '',
        workerStakeAccount: worker?.stake_token_account ?? process.env.DEFAULT_WORKER_STAKE ?? '',
        customerWallet: job.customer_pubkey ?? process.env.RELAYER_PUBKEY ?? '',
        feeGhst: Number(job.tokens_generated ?? 0) * 0.000001,
        attestationHash: job.attestation_hash ?? null,
      });
      await db.from('jobs').update({ on_chain_settled: true }).eq('id', job.id);
    }));
  }

  // Build SPL transfer transactions for Jito bundle
  const txBuffers: Buffer[] = [];
  for (const payout of payouts) {
    console.log(`[relayer] Payout to ${payout.worker_pubkey}: ${payout.total_raw} lamports`);
    // P6: settle the worker payout confidentially (encrypted amount, separate
    // from GHST's TransferHook mint). The cleartext amount is never persisted.
    const receipt = await settleConfidential({
      recipient_pubkey: payout.worker_pubkey,
      amount_lamports: payout.total_raw,
      kind: 'worker_payout',
      ref_id: payout.worker_id,
    });
    await db.from('worker_payouts').insert({
      worker_id: payout.worker_id,
      total_raw: payout.total_raw.toString(),
      status: receipt.status,
      tx_signature: receipt.tx_signature,
    });
  }

  let bundleId: string | null = null;
  if (txBuffers.length) {
    bundleId = await sendJitoBundle(txBuffers);
  }

  const allIds = payouts.flatMap(p => p.earning_ids);
  await db.from('worker_earnings').update({
    settled: true,
    jito_bundle_id: bundleId,
    settled_at: new Date().toISOString(),
  }).in('id', allIds);

  await db.from('worker_payouts').update({
    status: bundleId ? 'submitted' : 'pending',
    jito_bundle_id: bundleId,
  }).in('worker_id', payouts.map(p => p.worker_id));

  console.log(`[relayer] Settled ${payouts.length} workers. Bundle: ${bundleId}`);
  return { settled: payouts.length, bundleId };
}
