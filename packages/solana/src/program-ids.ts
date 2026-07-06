import { PublicKey } from '@solana/web3.js';
import { getFeeCollectorGhstAta } from './tokens.js';

function pk(value: string | undefined, fallback: string): PublicKey {
  const v = value?.trim();
  if (v) {
    try {
      return new PublicKey(v);
    } catch {
      // ignore invalid env override (e.g. placeholder GHSTxxxxxxxx…)
    }
  }
  return new PublicKey(fallback);
}

/** Devnet program IDs — override via env at runtime. */
export function getProgramIds() {
  return {
    WORKER_REGISTRY: pk(process.env.WORKER_REGISTRY, 'FqFRLgewksUxwrtni1oXNAmcw2ZJ4oAWZWPHJgU9ACgo'),
    JOB_ROUTER:      pk(process.env.JOB_ROUTER,      'EfDmESepZJJfsUUCHX7KC4F5Rbnf7Bdt4mQX76DAT5nB'),
    DARK_POOL:       pk(process.env.DARK_POOL,       'DBm8msZ7Z7fM1AX7NQYpmrQS2g55AKxSUVAcFNmo6vqk'),
    GHST_STAKING:    pk(process.env.GHST_STAKING,    '3M1YFgQdviR9eFUVVarFgkhGiGyChfN8Nrt5W1zjxbAN'),
    FEE_COLLECTOR:   pk(process.env.FEE_COLLECTOR,   'AfLg5yqWBayDubpFPn8VAks2WmFmceJTQLWx7oHXnwq'),
    ATTESTATION:     pk(process.env.ATTESTATION,     '6t3oGF7eUHHj1ZiRZcr68i9AXgdt1GothfdLbffJLzKr'),
    GOVERNANCE:      pk(process.env.GOVERNANCE,      '4NgovqpUuSFYkRNQNupy9koZUKd8DNo5i4L2i4dXkj7f'),
  } as const;
}

export function getMintIds() {
  return {
    GHST: pk(process.env.GHST_MINT, 'EtSrSMNHkWAxQumXwdKU4KCxc6bAN5fFzsRVdnY3eNz5'),
    USDC: pk(process.env.USDC_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  } as const;
}

export const SEEDS = {
  WORKER:         Buffer.from('worker'),
  JOB:            Buffer.from('job'),
  ORDER:          Buffer.from('order'),
  SEALED_ORDER:   Buffer.from('sealed_order'),
  STAKER:         Buffer.from('staker'),
  FEE_VAULT:      Buffer.from('fee_vault'),
  ATTESTATION:    Buffer.from('attestation'),
  PRIVACY_POLICY: Buffer.from('privacy_policy'),
} as const;

export function findWorkerPda(pubkey: PublicKey, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().WORKER_REGISTRY;
  return PublicKey.findProgramAddressSync([SEEDS.WORKER, pubkey.toBuffer()], pid);
}

export function findJobPda(jobId: Buffer, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().JOB_ROUTER;
  return PublicKey.findProgramAddressSync([SEEDS.JOB, jobId], pid);
}

export function findOrderPda(orderId: Buffer, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().DARK_POOL;
  return PublicKey.findProgramAddressSync([SEEDS.ORDER, orderId], pid);
}

export function findStakerPda(pubkey: PublicKey, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().GHST_STAKING;
  return PublicKey.findProgramAddressSync([SEEDS.STAKER, pubkey.toBuffer()], pid);
}

export function findFeeVaultPda(programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().FEE_COLLECTOR;
  return PublicKey.findProgramAddressSync([SEEDS.FEE_VAULT], pid);
}

export function findSealedOrderPda(orderId: Buffer, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().DARK_POOL;
  return PublicKey.findProgramAddressSync([SEEDS.SEALED_ORDER, orderId], pid);
}

export function findAttestationPda(worker: PublicKey, programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().ATTESTATION;
  return PublicKey.findProgramAddressSync([SEEDS.ATTESTATION, worker.toBuffer()], pid);
}

export function findPrivacyPolicyPda(programId?: PublicKey): [PublicKey, number] {
  const pid = programId ?? getProgramIds().GOVERNANCE;
  return PublicKey.findProgramAddressSync([SEEDS.PRIVACY_POLICY], pid);
}

/** x402 payTo — GHST token account that receives inference payments. */
export function getFeeCollectorPayTo(): string {
  try {
    return getFeeCollectorGhstAta().toBase58();
  } catch {
    const fromEnv = process.env.FEE_COLLECTOR_GHST_ATA?.trim();
    if (fromEnv) return fromEnv;
    const [pda] = findFeeVaultPda();
    return pda.toBase58();
  }
}

/** Fee vault program PDA (data account, not SPL). */
export function getFeeVaultPdaAddress(): string {
  return findFeeVaultPda()[0].toBase58();
}
