/**
 * Full on-chain job lifecycle: open → assign → commit → finalize → settle → distribute.
 * Adapted from Gridlock's solana-settlement.ts for Ghost Compute's 6-program Anchor stack.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

const PROGRAM_IDS = {
  workerRegistry: process.env.WORKER_REGISTRY_PROGRAM_ID ?? '',
  jobRouter:      process.env.JOB_ROUTER_PROGRAM_ID ?? '',
  darkPool:       process.env.DARK_POOL_PROGRAM_ID ?? '',
  ghstStaking:    process.env.GHST_STAKING_PROGRAM_ID ?? '',
  feeCollector:   process.env.FEE_COLLECTOR_PROGRAM_ID ?? '',
  attestation:    process.env.ATTESTATION_PROGRAM_ID ?? '',
};

const SOLANA_RPC    = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
const GHST_MINT     = process.env.GHST_MINT ?? '';
const FEE_VAULT_PDA = process.env.FEE_COLLECTOR_PDA ?? '';

// Destination PDAs for fee distribution (60/20/10/10)
const STAKER_POOL  = process.env.STAKER_POOL ?? '';
const WORKER_PAYOUT = process.env.WORKER_PAYOUT ?? '';
const BURN_VAULT   = process.env.BURN_VAULT ?? '';
const TREASURY     = process.env.TREASURY ?? '';

const SETTLEMENT_ENABLED = process.env.SOLANA_SETTLEMENT_ENABLED === 'true';

// ── Borsh helpers ────────────────────────────────────────────────────────────

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

function borshString(value: string): Buffer {
  const enc = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(enc.length);
  return Buffer.concat([len, enc]);
}

function borshBool(v: boolean): Buffer {
  return Buffer.from([v ? 1 : 0]);
}

function borshU32(v: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}

function borshU64(v: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

function borshOptionBytes32(v: Buffer | null): Buffer {
  return v ? Buffer.concat([Buffer.from([1]), v]) : Buffer.from([0]);
}

// ── Keypair / RPC ─────────────────────────────────────────────────────────────

function loadRelayerKeypair(): Keypair | null {
  try {
    const raw = process.env.RELAYER_KEYPAIR ?? '';
    if (!raw) return null;
    const bytes = JSON.parse(
      raw.startsWith('[') ? raw : readFileSync(raw, 'utf8'),
    ) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

async function rpc<T>(method: string, params: unknown[]): Promise<{ result?: T; error?: unknown }> {
  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return res.json() as Promise<{ result?: T; error?: unknown }>;
}

async function sendAndConfirm(programId: string, data: Buffer, accounts: Array<{
  pubkey: PublicKey; isSigner: boolean; isWritable: boolean;
}>): Promise<boolean> {
  const kp = loadRelayerKeypair();
  if (!kp || !programId) return false;

  const { result: latest } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ]);
  const blockhash = latest?.value.blockhash;
  if (!blockhash) return false;

  const ix = new TransactionInstruction({ programId: new PublicKey(programId), keys: accounts, data });
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash, instructions: [ix] })
    .compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([kp]);

  const { result: sig, error } = await rpc<string>('sendTransaction', [
    Buffer.from(tx.serialize()).toString('base64'),
    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
  ]);
  if (error) { console.error('[on-chain] tx error:', error); return false; }
  if (!sig) return false;
  console.log(`[on-chain] tx: ${sig}`);
  return confirmTx(sig);
}

export async function confirmTx(sig: string, maxMs = 30_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const { result } = await rpc<{ value: Array<{ confirmationStatus?: string; err?: unknown }> }>(
      'getSignatureStatuses', [[sig], { searchTransactionHistory: true }],
    );
    const status = result?.value?.[0];
    if (status?.err) return false;
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function pda(programId: string, seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0];
}

function jobIdBytes(jobId: string): Buffer {
  return createHash('sha256').update(jobId).digest();
}

// ── Lifecycle instructions ───────────────────────────────────────────────────

/** Open job escrow on-chain when a job is submitted. */
export async function anchorOpenJob(
  jobId: string,
  guarantee: string,
  feeLamports: bigint,
  confidential: boolean,
  customerWallet: string,
): Promise<boolean> {
  if (!SETTLEMENT_ENABLED || !GHST_MINT || !FEE_VAULT_PDA || !customerWallet) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const jobPda  = pda(PROGRAM_IDS.jobRouter, [Buffer.from('job'), id]);
  const escrow  = pda(PROGRAM_IDS.jobRouter, [Buffer.from('job_escrow'), id]);
  const routerAuth = pda(PROGRAM_IDS.jobRouter, [Buffer.from('job_router')]);

  const data = Buffer.concat([
    discriminator('open_job'), id, borshString(guarantee), borshU64(feeLamports), borshBool(confidential),
  ]);
  return sendAndConfirm(PROGRAM_IDS.jobRouter, data, [
    { pubkey: kp.publicKey,           isSigner: true,  isWritable: true  },
    { pubkey: jobPda,                 isSigner: false, isWritable: true  },
    { pubkey: escrow,                 isSigner: false, isWritable: true  },
    { pubkey: routerAuth,             isSigner: false, isWritable: false },
    { pubkey: new PublicKey(customerWallet), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(GHST_MINT),      isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022,             isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]);
}

/** Assign a routed worker to the open job. */
export async function anchorAssignWorker(jobId: string, workerPubkey: string): Promise<boolean> {
  if (!SETTLEMENT_ENABLED) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;
  let worker: PublicKey;
  try { worker = new PublicKey(workerPubkey); } catch { return false; }

  const id = jobIdBytes(jobId);
  const jobPda = pda(PROGRAM_IDS.jobRouter, [Buffer.from('job'), id]);
  const data = Buffer.concat([discriminator('assign_worker'), id, worker.toBuffer()]);
  return sendAndConfirm(PROGRAM_IDS.jobRouter, data, [
    { pubkey: kp.publicKey, isSigner: true,  isWritable: false },
    { pubkey: jobPda,       isSigner: false, isWritable: true  },
  ]);
}

/** Commit SLA receipt after job completes. */
export async function anchorCommitReceipt(
  jobId: string,
  guarantee: string,
  ttftMs: number,
  tpotMs: number,
  slaMet: boolean,
  confidential: boolean,
  attestationHash: string | null,
): Promise<boolean> {
  if (!SETTLEMENT_ENABLED) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const receiptPda = pda(PROGRAM_IDS.attestation, [Buffer.from('receipt'), id]);
  const attestBytes = confidential && attestationHash
    ? Buffer.from(attestationHash.replace(/^0x/, '').slice(0, 64), 'hex').subarray(0, 32)
    : null;

  const data = Buffer.concat([
    discriminator('commit_receipt'), id,
    borshString(guarantee), borshU32(ttftMs), borshU32(tpotMs),
    Buffer.alloc(64), // signature placeholder
    borshBool(slaMet), borshBool(confidential), borshOptionBytes32(attestBytes),
  ]);
  return sendAndConfirm(PROGRAM_IDS.attestation, data, [
    { pubkey: kp.publicKey,         isSigner: true,  isWritable: true  },
    { pubkey: receiptPda,           isSigner: false, isWritable: true  },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]);
}

/** Finalize receipt after challenge window passes. */
export async function anchorFinalizeReceipt(jobId: string): Promise<boolean> {
  if (!SETTLEMENT_ENABLED) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const receiptPda = pda(PROGRAM_IDS.attestation, [Buffer.from('receipt'), id]);
  return sendAndConfirm(PROGRAM_IDS.attestation, discriminator('finalize_unchallenged'), [
    { pubkey: kp.publicKey, isSigner: true,  isWritable: false },
    { pubkey: receiptPda,   isSigner: false, isWritable: true  },
  ]);
}

/** Settle (pay worker) or penalize (slash stake) based on SLA receipt. */
export async function anchorSettleOrPenalize(
  jobId: string,
  workerPubkey: string,
  workerStakeAccount: string,
  customerWallet: string,
): Promise<boolean> {
  if (!SETTLEMENT_ENABLED || !GHST_MINT || !FEE_VAULT_PDA) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;

  const id = jobIdBytes(jobId);
  const enforcer  = pda(PROGRAM_IDS.attestation, [Buffer.from('sla_enforcer')]);
  const receipt   = pda(PROGRAM_IDS.attestation, [Buffer.from('receipt'), id]);
  const jobPda    = pda(PROGRAM_IDS.jobRouter,   [Buffer.from('job'), id]);
  const escrow    = pda(PROGRAM_IDS.jobRouter,   [Buffer.from('job_escrow'), id]);
  const routerAuth = pda(PROGRAM_IDS.jobRouter,  [Buffer.from('job_router')]);

  const data = Buffer.concat([discriminator('settle_or_penalize'), id]);
  return sendAndConfirm(PROGRAM_IDS.attestation, data, [
    { pubkey: enforcer,                     isSigner: false, isWritable: false },
    { pubkey: receipt,                      isSigner: false, isWritable: true  },
    { pubkey: jobPda,                       isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(workerStakeAccount), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(customerWallet),     isSigner: false, isWritable: true },
    { pubkey: routerAuth,                   isSigner: false, isWritable: false },
    { pubkey: escrow,                       isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(FEE_VAULT_PDA), isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(GHST_MINT),     isSigner: false, isWritable: false },
    { pubkey: new PublicKey(PROGRAM_IDS.jobRouter), isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022,                   isSigner: false, isWritable: false },
  ]);
}

/** Distribute fees from fee_vault: 60% stakers / 20% workers / 10% burn / 10% treasury */
export async function anchorDistributeFees(amountLamports: bigint): Promise<boolean> {
  if (!SETTLEMENT_ENABLED || !GHST_MINT || !FEE_VAULT_PDA) return false;
  if (!STAKER_POOL || !WORKER_PAYOUT || !BURN_VAULT || !TREASURY) return false;
  const kp = loadRelayerKeypair();
  if (!kp) return false;

  const collector = pda(PROGRAM_IDS.feeCollector, [Buffer.from('fee_collector')]);
  const data = Buffer.concat([discriminator('distribute_fees'), borshU64(amountLamports)]);
  return sendAndConfirm(PROGRAM_IDS.feeCollector, data, [
    { pubkey: collector,                    isSigner: false, isWritable: false },
    { pubkey: new PublicKey(FEE_VAULT_PDA), isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(STAKER_POOL),   isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(WORKER_PAYOUT), isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(TREASURY),      isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(BURN_VAULT),    isSigner: false, isWritable: true  },
    { pubkey: new PublicKey(GHST_MINT),     isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022,                   isSigner: false, isWritable: false },
  ]);
}

/** Full pipeline after a job completes: commit → finalize → settle → distribute */
export async function runOnChainSettlement(opts: {
  jobId: string;
  guarantee: string;
  ttftMs: number;
  tpotMs: number;
  slaMet: boolean;
  confidential: boolean;
  workerPubkey: string;
  workerStakeAccount: string;
  customerWallet: string;
  feeGhst: number;
  attestationHash?: string | null;
}): Promise<void> {
  if (!SETTLEMENT_ENABLED) return;

  const ok1 = await anchorCommitReceipt(
    opts.jobId, opts.guarantee, opts.ttftMs, opts.tpotMs,
    opts.slaMet, opts.confidential, opts.attestationHash ?? null,
  );
  if (!ok1) { console.error('[on-chain] commit_receipt failed'); return; }

  // Wait for challenge window (2.5s on devnet)
  await new Promise(r => setTimeout(r, 2_500));

  const ok2 = await anchorFinalizeReceipt(opts.jobId);
  if (!ok2) { console.error('[on-chain] finalize_unchallenged failed'); return; }

  await anchorSettleOrPenalize(
    opts.jobId, opts.workerPubkey, opts.workerStakeAccount, opts.customerWallet,
  );

  const feeLamports = BigInt(Math.floor(opts.feeGhst * 1_000_000_000));
  if (feeLamports > 0n) await anchorDistributeFees(feeLamports);
}
