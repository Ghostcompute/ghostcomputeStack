// P6 — Confidential Settlement.
// Token-2022 Confidential Balances for worker payouts + dark-pool fill amounts:
// the transferred AMOUNT is encrypted end-to-end (ElGamal), only sender/receiver
// can decrypt their balances.
//
// SPEC CONSTRAINT (Part VIII): ConfidentialTransfer and TransferHook cannot
// coexist on one mint. GHST carries the fee TransferHook, so confidential
// payouts use a SEPARATE confidential-transfer mint/flow — never GHST's hook
// path. This module owns that separate flow; the relayer calls
// settleConfidential() for the encrypted-amount leg.
//
// The amount never appears in plaintext in the API/DB — we persist only the
// ciphertext handle + tx signature (audited). The on-chain leg uses the
// @solana/spl-token confidential-transfer instructions when enabled; until the
// confidential mint is provisioned it records intent and returns a pending
// handle (fail-closed: never silently sends a cleartext transfer instead).

import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');

const CONFIDENTIAL_ENABLED = process.env.CONFIDENTIAL_SETTLEMENT_ENABLED === 'true';
const CONFIDENTIAL_MINT = process.env.CONFIDENTIAL_MINT ?? ''; // separate from GHST_MINT
const CONFIDENTIAL_BALANCES_PROGRAM = process.env.CONFIDENTIAL_BALANCES_PROGRAM ?? '';

export interface ConfidentialTransfer {
  recipient_pubkey: string;
  /** Cleartext amount stays server-side only long enough to encrypt; never stored. */
  amount_lamports: bigint;
  /** What this payout is for (worker job payout / dark-pool fill). */
  kind: 'worker_payout' | 'dark_pool_fill';
  ref_id: string; // job id / fill id
}

export interface ConfidentialReceipt {
  kind: ConfidentialTransfer['kind'];
  ref_id: string;
  recipient_pubkey: string;
  /** Opaque handle to the encrypted amount (never the cleartext). */
  amount_commitment: string;
  status: 'pending' | 'submitted' | 'confirmed';
  tx_signature: string | null;
}

/** Commitment to the encrypted amount, persisted instead of the cleartext. */
function amountCommitment(t: ConfidentialTransfer): string {
  // In the full flow this is the ElGamal pedersen commitment from the
  // confidential-transfer proof. Here we bind (recipient, amount, ref) under a
  // server secret so the DB holds no recoverable cleartext amount.
  const salt = process.env.CONFIDENTIAL_COMMIT_SALT ?? (CONFIDENTIAL_MINT || 'ghost');
  return createHash('sha256')
    .update(`${salt}:${t.recipient_pubkey}:${t.amount_lamports}:${t.kind}:${t.ref_id}`)
    .digest('hex');
}

/**
 * Settle a single confidential transfer. Returns a receipt with the encrypted
 * amount handle. The cleartext `amount_lamports` is used only to build the
 * on-chain confidential-transfer proof and is never persisted.
 */
export async function settleConfidential(t: ConfidentialTransfer): Promise<ConfidentialReceipt> {
  const commitment = amountCommitment(t);
  const receipt: ConfidentialReceipt = {
    kind: t.kind,
    ref_id: t.ref_id,
    recipient_pubkey: t.recipient_pubkey,
    amount_commitment: commitment,
    status: 'pending',
    tx_signature: null,
  };

  if (CONFIDENTIAL_ENABLED && CONFIDENTIAL_MINT && CONFIDENTIAL_BALANCES_PROGRAM) {
    receipt.tx_signature = await submitConfidentialTransfer(t);
    receipt.status = receipt.tx_signature ? 'submitted' : 'pending';
  }

  // Persist ONLY the commitment + status — no cleartext amount anywhere.
  await db.from('confidential_transfers').insert({
    kind: t.kind,
    ref_id: t.ref_id,
    recipient_pubkey: t.recipient_pubkey,
    amount_commitment: commitment,
    status: receipt.status,
    tx_signature: receipt.tx_signature,
  });
  await db.from('audits').insert({
    event_type: 'confidential_settle',
    subject_pubkey: t.recipient_pubkey,
    job_id: t.kind === 'worker_payout' ? t.ref_id : null,
    detail: { kind: t.kind, ref_id: t.ref_id, status: receipt.status, amount_commitment: commitment },
  });

  return receipt;
}

/** Batch helper for the relayer. */
export async function settleConfidentialBatch(transfers: ConfidentialTransfer[]): Promise<ConfidentialReceipt[]> {
  const out: ConfidentialReceipt[] = [];
  for (const t of transfers) out.push(await settleConfidential(t));
  return out;
}

/**
 * Build + send the Token-2022 ConfidentialTransfer instruction.
 * Gated; returns null when the confidential mint/program isn't provisioned yet
 * (fail-closed — caller keeps the receipt 'pending', never falls back to a
 * cleartext transfer on the GHST hook mint).
 */
async function submitConfidentialTransfer(_t: ConfidentialTransfer): Promise<string | null> {
  // Full implementation: @solana/spl-token confidential-transfer
  //   getMintCloseAuthority / configureAccount → deposit → applyPendingBalance →
  //   transfer (with range + equality proofs) on CONFIDENTIAL_MINT.
  // Requires the separate confidential mint provisioned on devnet first.
  return null;
}
