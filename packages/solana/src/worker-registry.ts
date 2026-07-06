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
import { findWorkerPda } from './program-ids.js';
import { loadDevWallet } from './wallet.js';

export function isWorkerRegistryOnChainEnabled(): boolean {
  return process.env.WORKER_REGISTRY_ONCHAIN_ENABLED === 'true';
}

export function teeTypeToU8(tee: string): number {
  switch (tee) {
    case 'nvidia_cc': return 1;
    case 'amd_sev_snp': return 2;
    default: return 0;
  }
}

export function modelToHash(model: string): number[] {
  const hash = createHash('sha256').update(`ghost:model:${model}`).digest();
  return [...hash] as number[];
}

/** Dev/proxy path: register when worker pubkey matches DEV_WALLET. */
export function resolveWorkerRegistryAuthority(workerPubkey: string): Keypair | null {
  if (!isWorkerRegistryOnChainEnabled()) return null;
  try {
    const dev = loadDevWallet();
    if (dev.publicKey.toBase58() === workerPubkey) return dev;
  } catch {
    return null;
  }
  return null;
}

export async function workerRegistryAccountExists(
  connection: Connection,
  authority: PublicKey,
): Promise<boolean> {
  const [workerPda] = findWorkerPda(authority);
  const info = await connection.getAccountInfo(workerPda);
  return info !== null && info.data.length > 0;
}

export async function registerWorkerOnChain(
  connection: Connection,
  authority: Keypair,
  model: string,
  tokPerSec: number,
  teeType: string,
  vramGb: number,
): Promise<string | null> {
  if (await workerRegistryAccountExists(connection, authority.publicKey)) {
    console.log(`[worker-registry] already registered ${authority.publicKey.toBase58()}`);
    return null;
  }

  const programs = createGhostPrograms(connection, authority);
  const workerRegistry = programs.workerRegistry as Program;
  const [workerPda] = findWorkerPda(authority.publicKey);

  const sig = await workerRegistry.methods
    .registerWorker({
      modelHash: modelToHash(model),
      tokPerSec: Math.round(tokPerSec),
      teeType: teeTypeToU8(teeType),
      vramGb,
    })
    .accounts({
      worker: workerPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`[worker-registry] register_worker ${authority.publicKey.toBase58()} → ${sig}`);
  return sig;
}

export async function updateAttestationOnChain(
  connection: Connection,
  oracle: Keypair,
  workerPubkey: string,
  confidentialOk: boolean,
  verifyPassRateBps: number,
  attestUptimeBps: number,
  lastAttestUnix: number,
): Promise<string> {
  const programs = createGhostPrograms(connection, oracle);
  const workerRegistry = programs.workerRegistry as Program;
  const workerPk = new PublicKey(workerPubkey);
  const [workerPda] = findWorkerPda(workerPk);

  const sig = await workerRegistry.methods
    .updateAttestation(
      confidentialOk,
      verifyPassRateBps,
      attestUptimeBps,
      new BN(lastAttestUnix),
    )
    .accounts({
      worker: workerPda,
      oracle: oracle.publicKey,
    })
    .rpc();

  console.log(`[worker-registry] update_attestation ${workerPubkey} → ${sig}`);
  return sig;
}
