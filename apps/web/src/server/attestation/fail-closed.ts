// P8 — Fail-closed enforcement.
// The privacy guarantee only holds if every gap defaults to "deny". These guards
// are pure functions (easily unit-tested) plus thin DB-backed wrappers used by
// the job router. Rules:
//   • stale `last_attest`  → worker dropped from confidential routing
//   • not `confidential_ok` → never receives High / MaxTrustSplit jobs
//   • broken envelope / unseal failure → job halts, plaintext never leaks

import { createClient } from '@supabase/supabase-js';
import { Guarantee } from '@ghost-compute/shared';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

/** Append-only audit insert (kept local so pure guards don't pull in the
 *  Solana-heavy attestation service at import time). */
async function audit(eventType: string, subjectPubkey: string | null, detail: Record<string, unknown>, jobId?: string) {
  await db.from('audits').insert({ event_type: eventType, subject_pubkey: subjectPubkey, job_id: jobId ?? null, detail });
}

const DEFAULT_MAX_AGE_MS = Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? 3600) * 1000;

export interface WorkerAttestState {
  pubkey: string;
  confidential_ok: boolean;
  /** ISO timestamp or epoch ms of last successful attestation; null = never. */
  last_attest: string | number | null;
}

/** A guarantee tier that requires an attested confidential enclave. */
export function isConfidentialTier(g: Guarantee): boolean {
  return g === Guarantee.High || g === Guarantee.MaxTrustSplit;
}

/** True when the worker's last attestation is older than maxAge (or never). */
export function isAttestationStale(
  lastAttest: string | number | null,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): boolean {
  if (lastAttest == null) return true;
  const t = typeof lastAttest === 'number' ? lastAttest : Date.parse(lastAttest);
  if (Number.isNaN(t)) return true; // unparseable → treat as stale (fail closed)
  return now - t > maxAgeMs;
}

/**
 * Pure decision: may this worker take a job at this guarantee tier?
 * Non-confidential tiers are always allowed; confidential tiers require
 * confidential_ok AND a fresh attestation.
 */
export function eligibleForRouting(
  worker: WorkerAttestState,
  guarantee: Guarantee,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): { ok: boolean; reason?: string } {
  if (!isConfidentialTier(guarantee)) return { ok: true };
  if (!worker.confidential_ok) return { ok: false, reason: 'worker not confidential_ok' };
  if (isAttestationStale(worker.last_attest, now, maxAgeMs)) {
    return { ok: false, reason: 'stale attestation' };
  }
  return { ok: true };
}

/** Filter a candidate worker set down to those eligible for the tier. */
export function filterEligibleWorkers<T extends WorkerAttestState>(
  workers: T[],
  guarantee: Guarantee,
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): T[] {
  return workers.filter((w) => eligibleForRouting(w, guarantee, now, maxAgeMs).ok);
}

/**
 * DB-backed guard for the job router. For confidential tiers, sweep stale
 * workers (mark confidential_ok = false + audit), then assert this worker is
 * still eligible. Throws to HALT the job if not — fail closed.
 */
export async function enforceConfidentialRouting(workerPubkey: string, guarantee: Guarantee): Promise<void> {
  if (!isConfidentialTier(guarantee)) return;

  const { data: worker } = await db.from('workers')
    .select('pubkey, confidential_ok, last_attest')
    .eq('pubkey', workerPubkey).single();

  const state: WorkerAttestState = worker ?? { pubkey: workerPubkey, confidential_ok: false, last_attest: null };
  const decision = eligibleForRouting(state, guarantee);

  if (!decision.ok) {
    // Drop the worker from confidential routing and record why.
    if (state.confidential_ok) {
      await db.from('workers').update({ confidential_ok: false }).eq('pubkey', workerPubkey);
    }
    await audit('worker_dropped', workerPubkey, { guarantee, reason: decision.reason });
    throw new EnvelopeHaltError(`fail-closed: ${decision.reason}`);
  }
}

/**
 * Wrap an in-enclave unseal/compute. Any failure halts the job and is audited;
 * the error is re-thrown so no caller can proceed on partial/leaked state.
 */
export async function withEnvelope<T>(jobId: string, workerPubkey: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await audit('envelope_halt', workerPubkey, { error: (err as Error).message }, jobId);
    throw new EnvelopeHaltError(`envelope broken for job ${jobId}: ${(err as Error).message}`);
  }
}

export class EnvelopeHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeHaltError';
  }
}
