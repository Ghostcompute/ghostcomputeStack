import BN from 'bn.js';
import { createHash } from 'node:crypto';
import { Program } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js';
import { createGhostPrograms } from './programs.js';
import { findJobPda, getProgramIds } from './program-ids.js';

export function uuidToJobIdBytes(jobId: string): Buffer {
  const hex = jobId.replace(/-/g, '');
  if (hex.length !== 32) {
    throw new Error(`Invalid job UUID: ${jobId}`);
  }
  return Buffer.from(hex, 'hex');
}

export function guaranteeToU8(guarantee: string): number {
  switch (guarantee) {
    case 'high': return 1;
    case 'max_trust_split': return 2;
    default: return 0;
  }
}

export function toplocHexToBytes(toploc: string): number[] {
  const hex = toploc.startsWith('0x') ? toploc.slice(2) : toploc;
  const buf = Buffer.from(hex.padStart(64, '0').slice(0, 64), 'hex');
  return [...buf];
}

export function toplocPlaceholder(jobId: string): number[] {
  const hash = createHash('sha256').update(`ghost:toploc:${jobId}`).digest();
  return [...hash];
}

export function isJobRouterEnabled(): boolean {
  return process.env.JOB_ROUTER_ONCHAIN_ENABLED === 'true';
}

export async function submitJobOnChain(
  connection: Connection,
  owner: Keypair,
  jobId: string,
  guarantee: string,
  x402Amount: bigint,
): Promise<string> {
  const programs = createGhostPrograms(connection, owner);
  const jobRouter = programs.jobRouter as Program;
  const idBytes = [...uuidToJobIdBytes(jobId)] as number[];
  const [jobPda] = findJobPda(uuidToJobIdBytes(jobId));

  const sig = await jobRouter.methods
    .submitJob({
      id: idBytes,
      guarantee: guaranteeToU8(guarantee),
      x402Amount: new BN(x402Amount.toString()),
    })
    .accounts({
      job: jobPda,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`[job-router] submit_job ${jobId} → ${sig}`);
  return sig;
}

export async function completeJobOnChain(
  connection: Connection,
  oracle: Keypair,
  jobId: string,
  toplocHex?: string | null,
): Promise<string> {
  const programs = createGhostPrograms(connection, oracle);
  const jobRouter = programs.jobRouter as Program;
  const [jobPda] = findJobPda(uuidToJobIdBytes(jobId));
  const toploc = toplocHex ? toplocHexToBytes(toplocHex) : toplocPlaceholder(jobId);

  const sig = await jobRouter.methods
    .completeJob(toploc)
    .accounts({
      job: jobPda,
      oracle: oracle.publicKey,
    })
    .rpc();

  console.log(`[job-router] complete_job ${jobId} → ${sig}`);
  return sig;
}

import { loadDevWallet } from './wallet.js';

export function resolveJobRouterOracle(): Keypair | null {
  try {
    if (process.env.DEV_X402_SIGN === 'true' || process.env.JOB_ROUTER_ONCHAIN_ENABLED === 'true') {
      return loadDevWallet();
    }
  } catch {
    return null;
  }
  return null;
}

export function getJobRouterProgramId(): PublicKey {
  return getProgramIds().JOB_ROUTER;
}
