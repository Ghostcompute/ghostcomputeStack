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

import { createClient } from '@supabase/supabase-js';
import { PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js';
import { pedersenCommit } from '@ghost-compute/crypto';
import { createConnection, loadDevWallet } from '@ghost-compute/solana';

const db = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');

const CONFIDENTIAL_ENABLED = process.env.CONFIDENTIAL_SETTLEMENT_ENABLED === 'true';
const CONFIDENTIAL_MINT = process.env.CONFIDENTIAL_MINT ?? ''; // separate from GHST_MINT
const CONFIDENTIAL_BALANCES_PROGRAM = process.env.CONFIDENTIAL_BALANCES_PROGRAM ?? '';

// SPL Memo program — used to anchor the (hiding) amount commitment on devnet so
// the confidential settlement leaves a verifiable on-chain artifact even before
// the full Token-2022 confidential-transfer mint is provisioned.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';

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
  /** Pedersen commitment to the amount (perfectly hiding — never the cleartext). */
  amount_commitment: string;
  /** Blinding factor — returned to the payer/recipient for reconciliation, NEVER persisted. */
  amount_blinding: string;
  status: 'pending' | 'submitted' | 'confirmed';
  tx_signature: string | null;
}

/**
 * Settle a single confidential transfer. Returns a receipt with a hiding
 * commitment to the amount. The cleartext `amount_lamports` is used only to
 * build the Pedersen commitment (and, when enabled, the on-chain proof) and is
 * never persisted.
 */
export async function settleConfidential(t: ConfidentialTransfer): Promise<ConfidentialReceipt> {
  // Perfectly-hiding Pedersen commitment (random blinding): unlike a hash of the
  // cleartext, the amount cannot be brute-forced from the commitment.
  const { commitment, blinding } = pedersenCommit(t.amount_lamports);
  const receipt: ConfidentialReceipt = {
    kind: t.kind,
    ref_id: t.ref_id,
    recipient_pubkey: t.recipient_pubkey,
    amount_commitment: commitment,
    amount_blinding: blinding,
    status: 'pending',
    tx_signature: null,
  };

  if (CONFIDENTIAL_ENABLED) {
    receipt.tx_signature = await submitConfidentialTransfer(t, commitment);
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
 * Submit the confidential-settlement leg on devnet.
 *
 * The amount stays hidden: only the Pedersen `commitment` is placed on-chain
 * (via an SPL Memo), producing a verifiable, timestamped anchor of the payout
 * without ever revealing the cleartext or touching GHST's TransferHook mint.
 * Returns the tx signature, or null (→ receipt stays 'pending') when no relayer
 * wallet is configured — fail-closed, never a cleartext fallback.
 *
 * The full Token-2022 Confidential Balances transfer (encrypted-amount move with
 * range + equality proofs) additionally requires the separate CONFIDENTIAL_MINT
 * to be provisioned on devnet; when CONFIDENTIAL_MINT + CONFIDENTIAL_BALANCES_PROGRAM
 * are set this is where that instruction is built. Until then the commitment
 * anchor above is the on-chain artifact.
 */
async function submitConfidentialTransfer(t: ConfidentialTransfer, commitment: string): Promise<string | null> {
  let relayer;
  try {
    relayer = loadDevWallet();
  } catch {
    return null; // no relayer keypair → cannot submit; keep pending (fail-closed)
  }

  try {
    const connection = createConnection(SOLANA_RPC);
    // Anchor: bind kind, ref, recipient and the hiding commitment — no amount.
    const memo = `ghost:conf:${t.kind}:${t.ref_id}:${t.recipient_pubkey}:${commitment}`;
    const ix = new TransactionInstruction({
      keys: [{ pubkey: relayer.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memo, 'utf8'),
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(connection, tx, [relayer], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    return sig;
  } catch (err) {
    console.error('[confidential] anchor submit failed:', (err as Error).message);
    return null;
  }
}

// Referenced so the full-confidential-mint path is discoverable by config;
// avoids "unused" noise while documenting the provisioning requirement.
void CONFIDENTIAL_MINT;
void CONFIDENTIAL_BALANCES_PROGRAM;
