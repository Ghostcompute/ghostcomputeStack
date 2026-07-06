// P7 — Attestation Explorer queries.
// Public, no-auth trust surface: network sealed-share, worker reputation,
// per-job receipts, audit feed, verify-any-hash. Identities are withheld
// (pubkeys truncated) — only the cryptographic trust signal is exposed.

import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');

const short = (pk: string | null) => (pk ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : 'withheld');

export interface NetworkStats {
  confidential_workers: number;
  total_workers: number;
  sealed_share: number; // fraction of workers that are confidential_ok
  attestations_verified: number;
  attestations_rejected: number;
  proofs_recorded: number;
  proofs_verified: number;
}

export async function getNetworkStats(): Promise<NetworkStats> {
  const [workersRes, confRes, attVerifiedRes, attRejectedRes, proofsRes, proofsVerifiedRes] = await Promise.all([
    db.from('workers').select('id', { count: 'exact', head: true }),
    db.from('workers').select('id', { count: 'exact', head: true }).eq('confidential_ok', true),
    db.from('attestations').select('id', { count: 'exact', head: true }).eq('verdict', 'verified'),
    db.from('attestations').select('id', { count: 'exact', head: true }).eq('verdict', 'rejected'),
    db.from('proofs').select('id', { count: 'exact', head: true }),
    db.from('proofs').select('id', { count: 'exact', head: true }).eq('verified', true),
  ]);

  const total = workersRes.count ?? 0;
  const confidential = confRes.count ?? 0;
  return {
    confidential_workers: confidential,
    total_workers: total,
    sealed_share: total ? confidential / total : 0,
    attestations_verified: attVerifiedRes.count ?? 0,
    attestations_rejected: attRejectedRes.count ?? 0,
    proofs_recorded: proofsRes.count ?? 0,
    proofs_verified: proofsVerifiedRes.count ?? 0,
  };
}

export async function getWorkerReputation(limit = 50) {
  const { data } = await db.from('workers')
    .select('pubkey, tee_type, confidential_ok, reputation, verify_pass_rate, attest_uptime, last_attest, jobs_completed')
    .order('reputation', { ascending: false })
    .limit(limit);
  return (data ?? []).map((w) => ({
    worker: short(w.pubkey),
    tee_type: w.tee_type,
    confidential_ok: w.confidential_ok,
    reputation_bps: Math.round(Number(w.reputation ?? 0) * 10000) / 1, // numeric → bps-ish
    verify_pass_rate: w.verify_pass_rate,
    attest_uptime: w.attest_uptime,
    last_attest: w.last_attest,
    jobs_completed: w.jobs_completed,
  }));
}

export async function getReceipts(limit = 50) {
  const { data } = await db.from('proofs')
    .select('job_id, proof_system, model_hash, output_hash, commitment, verified, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((p) => ({
    job_id: p.job_id,
    proof_system: p.proof_system,
    model_hash: p.model_hash,
    output_hash: p.output_hash,
    // expose a short fingerprint of the commitment, not the whole blob
    commitment_fp: typeof p.commitment === 'string' ? `${p.commitment.slice(0, 12)}…` : null,
    verified: p.verified,
    created_at: p.created_at,
  }));
}

export async function getAuditFeed(limit = 50) {
  const { data } = await db.from('audits')
    .select('event_type, subject_pubkey, job_id, detail, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((a) => ({
    event_type: a.event_type,
    subject: short(a.subject_pubkey),
    job_id: a.job_id,
    detail: a.detail,
    created_at: a.created_at,
  }));
}

export interface LiveFeedItem {
  ts: string;
  kind: string;
  message: string;
}

function feedKind(eventType: string): string {
  if (eventType.startsWith('attest')) return 'attest';
  if (eventType.includes('x402') || eventType.includes('payment')) return 'x402';
  if (eventType.includes('infer') || eventType.includes('job')) return 'infer';
  if (eventType.includes('dark') || eventType.includes('match') || eventType.includes('pool')) return 'fhe';
  if (eventType.includes('solana') || eventType.includes('anchor') || eventType.includes('chain')) return 'solana';
  return 'event';
}

function formatAuditLine(a: { event_type: string; subject_pubkey: string | null; job_id: string | null; detail: Record<string, unknown> | null }): string {
  const subj = short(a.subject_pubkey);
  const job = a.job_id ? `job ${a.job_id.slice(0, 8)}…` : '';
  const detail = a.detail && typeof a.detail === 'object' ? JSON.stringify(a.detail).slice(0, 60) : '';
  return [a.event_type, subj, job, detail].filter(Boolean).join(' · ');
}

/** Merged live feed for dashboard terminal (audits, proofs, x402, chain). */
export async function getLiveFeed(limit = 30): Promise<LiveFeedItem[]> {
  const items: LiveFeedItem[] = [];

  const [auditsRes, proofsRes, settlementsRes, chainRes] = await Promise.all([
    db.from('audits').select('event_type, subject_pubkey, job_id, detail, created_at')
      .order('created_at', { ascending: false }).limit(limit),
    db.from('proofs').select('job_id, verified, proof_system, created_at')
      .order('created_at', { ascending: false }).limit(limit),
    db.from('x402_settlements').select('job_id, amount_raw, tx_sig, created_at')
      .order('created_at', { ascending: false }).limit(limit),
    db.from('chain_events').select('signature, instruction, slot, created_at')
      .order('created_at', { ascending: false }).limit(limit),
  ]);

  if (chainRes.error) {
    // chain_events table may not exist until 004 migration is applied
    chainRes.data = [];
  }

  for (const a of auditsRes.data ?? []) {
    items.push({
      ts: a.created_at,
      kind: feedKind(a.event_type),
      message: formatAuditLine(a),
    });
  }

  for (const p of proofsRes.data ?? []) {
    items.push({
      ts: p.created_at,
      kind: 'infer',
      message: `proof ${p.proof_system ?? 'zk'} · job ${String(p.job_id).slice(0, 8)}… · ${p.verified ? 'verified' : 'pending'}`,
    });
  }

  for (const s of settlementsRes.data ?? []) {
    const ghst = Number(BigInt(s.amount_raw ?? '0')) / 1e9;
    items.push({
      ts: s.created_at,
      kind: 'x402',
      message: `402 → 200 · ${ghst.toFixed(4)} GHST · ${String(s.tx_sig ?? '').slice(0, 8)}…`,
    });
  }

  for (const c of chainRes.data ?? []) {
    items.push({
      ts: c.created_at,
      kind: 'solana',
      message: `${c.instruction ?? 'tx'} · slot ${c.slot ?? '—'} · ${String(c.signature).slice(0, 8)}…`,
    });
  }

  items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  return items.slice(0, limit);
}

export async function getAttestationList(limit = 20) {
  const { data } = await db.from('attestations')
    .select('worker_pubkey, report_hash, verdict, onchain_sig, onchain_slot, verified_at, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  return (data ?? []).map((a) => ({
    worker: short(a.worker_pubkey),
    report_hash: a.report_hash,
    quote_fp: `${a.report_hash.slice(0, 6)}…${a.report_hash.slice(-4)}`,
    tx_fp: a.onchain_sig ? `${a.onchain_sig.slice(0, 4)}…${a.onchain_sig.slice(-4)}` : '—',
    slot: a.onchain_slot ?? null,
    verdict: a.verified_at ? 'ok' : a.verdict,
    created_at: a.created_at,
  }));
}

export async function getChainEvents(limit = 50) {
  const { data, error } = await db.from('chain_events')
    .select('signature, slot, program_id, instruction, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return [];
  return data ?? [];
}

/** Active enclave public key a client seals to (P2 registry lookup). */
export async function getEnclaveKey(workerPubkey: string) {
  const { data } = await db.from('enclave_keys')
    .select('enclave_pubkey, tee_type, created_at')
    .eq('worker_pubkey', workerPubkey).eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1).single();
  return data;
}
