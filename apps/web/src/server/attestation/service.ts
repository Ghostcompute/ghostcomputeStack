// P3 — Attestation service: verify → persist → anchor → audit.
// Glues the pure verifier to Supabase (attestations, enclave_keys, audits) and
// the on-chain anchor (attestation program). verify-by-hash powers the explorer.

import { createHash } from 'node:crypto';
import {
  Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import type { AttestationQuote, AttestationResult } from '@ghost-compute/shared';
import { verifyQuote } from './verifier.js';
import {
  createConnection,
  isWorkerRegistryOnChainEnabled,
  loadDevWallet,
  updateAttestationOnChain,
} from '@ghost-compute/solana';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

const SETTLEMENT_ENABLED = process.env.SOLANA_SETTLEMENT_ENABLED === 'true';
const SOLANA_RPC = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const ATTESTATION_PROGRAM = process.env.ATTESTATION_PROGRAM_ID ?? process.env.ATTESTATION ?? '';

const TEE_CODE: Record<string, number> = { none: 0, nvidia_cc: 1, amd_sev_snp: 2 };

/** Audit-log a privacy-relevant event (append-only trust surface). */
export async function audit(eventType: string, subjectPubkey: string | null, detail: Record<string, unknown>, jobId?: string) {
  await db.from('audits').insert({
    event_type: eventType,
    subject_pubkey: subjectPubkey,
    job_id: jobId ?? null,
    detail,
  });
}

/**
 * Full attestation pipeline: verify the quote, persist the verdict, publish the
 * enclave key on success, optionally anchor the report hash on-chain, audit.
 */
export async function processAttestation(
  quote: AttestationQuote,
  expectedNonce?: string,
): Promise<AttestationResult> {
  const result = verifyQuote(quote, expectedNonce);

  const { data: row } = await db.from('attestations').upsert({
    worker_pubkey: result.worker_pubkey,
    tee_type: result.tee_type,
    nonce: quote.nonce,
    report_hash: result.report_hash,
    verdict: result.verdict,
    reject_reason: result.reject_reason ?? null,
    vendor_root_id: result.vendor_root_id ?? null,
    verified_at: result.verdict === 'verified' ? new Date().toISOString() : null,
  }, { onConflict: 'report_hash' }).select('id').single();

  if (result.verdict === 'verified') {
    // Publish/rotate the enclave key clients seal to.
    await db.from('enclave_keys')
      .update({ active: false, rotated_at: new Date().toISOString() })
      .eq('worker_pubkey', result.worker_pubkey).eq('active', true);
    await db.from('enclave_keys').upsert({
      worker_pubkey: result.worker_pubkey,
      enclave_pubkey: result.enclave_pubkey,
      tee_type: result.tee_type,
      attestation_id: row?.id ?? null,
      active: true,
    }, { onConflict: 'worker_pubkey,enclave_pubkey' });

    // Refresh worker freshness so confidential routing keeps it eligible (P8).
    await db.from('workers')
      .update({ confidential_ok: true, last_attest: new Date().toISOString() })
      .eq('pubkey', result.worker_pubkey);

    if (isWorkerRegistryOnChainEnabled()) {
      try {
        const oracle = loadDevWallet();
        const rpc = process.env.SOLANA_RPC ?? SOLANA_RPC;
        await updateAttestationOnChain(
          createConnection(rpc),
          oracle,
          result.worker_pubkey,
          true,
          10_000,
          10_000,
          Math.floor(Date.now() / 1000),
        );
      } catch (err) {
        console.error('[attestation] worker registry update failed:', (err as Error).message);
      }
    }

    const anchor = await anchorAttestationOnChain(result.report_hash, result.tee_type, quote.timestamp, result.worker_pubkey);
    if (anchor) {
      await db.from('attestations').update({ onchain_sig: anchor }).eq('report_hash', result.report_hash);
    }
  }

  await audit(
    result.verdict === 'verified' ? 'attest_verified' : 'attest_failed',
    result.worker_pubkey,
    { verdict: result.verdict, tee_type: result.tee_type, report_hash: result.report_hash, reason: result.reject_reason },
  );

  return result;
}

/** verify-by-hash for the Attestation Explorer (P7). Identity-safe projection. */
export async function getAttestationByHash(reportHash: string) {
  const { data } = await db.from('attestations')
    .select('report_hash, tee_type, verdict, vendor_root_id, onchain_sig, onchain_slot, verified_at, created_at')
    .eq('report_hash', reportHash).single();
  return data;
}

// ── On-chain anchor (attestation program submit_attestation) ─────────────────

function loadRelayer(): Keypair | null {
  try {
    const raw = process.env.RELAYER_KEYPAIR ?? '';
    if (!raw) return null;
    const bytes = JSON.parse(raw.startsWith('[') ? raw : '[]') as number[];
    return bytes.length ? Keypair.fromSecretKey(Uint8Array.from(bytes)) : null;
  } catch { return null; }
}

function disc(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | undefined> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json() as { result?: T }).result;
}

/**
 * Anchor report_hash via attestation.submit_attestation. Gated by
 * SOLANA_SETTLEMENT_ENABLED + a configured relayer keypair + program id.
 * Returns the tx signature, or null when anchoring is disabled/unavailable.
 */
export async function anchorAttestationOnChain(
  reportHashHex: string,
  teeType: string,
  timestampMs: number,
  workerPubkey: string,
): Promise<string | null> {
  if (!SETTLEMENT_ENABLED || !ATTESTATION_PROGRAM) return null;
  const kp = loadRelayer();
  if (!kp) return null;
  let worker: PublicKey;
  try { worker = new PublicKey(workerPubkey); } catch { return null; }

  const programId = new PublicKey(ATTESTATION_PROGRAM);
  const record = PublicKey.findProgramAddressSync(
    [Buffer.from('attestation'), worker.toBuffer()], programId,
  )[0];

  const teeByte = TEE_CODE[teeType] ?? 0;
  const reportHash = Buffer.from(reportHashHex, 'hex').subarray(0, 32);
  const ts = Buffer.alloc(8);
  ts.writeBigInt64LE(BigInt(Math.floor(timestampMs / 1000)));
  const data = Buffer.concat([disc('submit_attestation'), Buffer.from([teeByte]), reportHash, ts]);

  const blockhash = (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]))?.value.blockhash;
  if (!blockhash) return null;

  const ix = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: kp.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const sig = await rpc<string>('sendTransaction', [
    Buffer.from(tx.serialize()).toString('base64'),
    { encoding: 'base64', preflightCommitment: 'confirmed' },
  ]);
  return sig ?? null;
}
