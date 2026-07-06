import BN from 'bn.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { createGhostPrograms } from './programs.js';
import { findFeeVaultPda, getMintIds } from './program-ids.js';
import {
  getFeeCollectorGhstAta,
  getGhstMint,
  getTokenAccountBalanceRaw,
  resolveTokenProgram,
} from './tokens.js';
import { loadDevWallet } from './wallet.js';

export interface FeeDestinations {
  stakerPool: PublicKey;
  workerPayout: PublicKey;
  burnVault: PublicKey;
  treasury: PublicKey;
}

export function getFeeDestinations(tokenProgram: PublicKey): FeeDestinations {
  const mint = getGhstMint();
  const env = (key: string, fallback: string) => {
    const v = process.env[key]?.trim();
    if (v) {
      try {
        return new PublicKey(v);
      } catch {
        // fall through
      }
    }
    return new PublicKey(fallback);
  };

  const stakerPool = env('STAKER_POOL', '11111111111111111111111111111111');
  const workerPayout = env('WORKER_PAYOUT', '11111111111111111111111111111111');
  const burnVault = env('BURN_VAULT', '11111111111111111111111111111111');
  const treasury = env('TREASURY', '11111111111111111111111111111111');

  return {
    stakerPool: getAssociatedTokenAddressSync(mint, stakerPool, true, tokenProgram),
    workerPayout: getAssociatedTokenAddressSync(mint, workerPayout, true, tokenProgram),
    burnVault: getAssociatedTokenAddressSync(mint, burnVault, true, tokenProgram),
    treasury: getAssociatedTokenAddressSync(mint, treasury, true, tokenProgram),
  };
}

/** Ensure fee distribution destination ATAs exist. */
export async function ensureFeeDestinationAtas(
  connection: Connection,
  payer: Keypair,
): Promise<FeeDestinations> {
  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const dests = getFeeDestinations(tokenProgram);

  const owners = [
    process.env.STAKER_POOL?.trim() ?? '',
    process.env.WORKER_PAYOUT?.trim() ?? '',
    process.env.BURN_VAULT?.trim() ?? '',
    process.env.TREASURY?.trim() ?? '',
  ].filter(Boolean);

  const ix = owners.flatMap((ownerStr) => {
    try {
      const owner = new PublicKey(ownerStr);
      const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
      return [createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey, ata, owner, mint, tokenProgram,
      )];
    } catch {
      return [];
    }
  });

  if (ix.length) {
    const tx = new Transaction().add(...ix);
    await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });
  }

  return dests;
}

/** Initialize fee_vault PDA account if missing. */
export async function initializeFeeVaultIfNeeded(
  connection: Connection,
  payer: Keypair,
): Promise<void> {
  const programs = createGhostPrograms(connection, payer);
  const feeCollector = programs.feeCollector as import('@coral-xyz/anchor').Program;
  const [feeVault] = findFeeVaultPda();

  const info = await connection.getAccountInfo(feeVault);
  if (info) return;

  await feeCollector.methods
    .initializeFeeVault()
    .accounts({
      feeVault,
      payer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Call on-chain distribute + emit FeeDistributed event. */
export async function distributeCollectedFees(
  connection: Connection,
  authority: Keypair,
  total: bigint,
): Promise<string> {
  const programs = createGhostPrograms(connection, authority);
  const feeCollector = programs.feeCollector as import('@coral-xyz/anchor').Program;
  const [feeVault] = findFeeVaultPda();

  const sig = await feeCollector.methods
    .distribute(new BN(total.toString()))
    .accounts({
      feeVault,
      authority: authority.publicKey,
    })
    .rpc();

  console.log(`[fee-distribute] distribute(${total}) → ${sig}`);
  return sig;
}

/** Read fee vault GHST ATA balance and distribute if above threshold. */
export async function distributeVaultBalanceIfReady(
  connection: Connection,
  authority: Keypair,
  minRaw = 51200n,
): Promise<string | null> {
  const tokenProgram = await resolveTokenProgram(connection, getGhstMint());
  const vaultAta = getFeeCollectorGhstAta(tokenProgram);
  const balance = await getTokenAccountBalanceRaw(connection, vaultAta);
  if (balance < minRaw) {
    console.log(`[fee-distribute] Vault balance ${balance} below threshold ${minRaw}`);
    return null;
  }

  await initializeFeeVaultIfNeeded(connection, authority);
  return distributeCollectedFees(connection, authority, balance);
}

export { getMintIds };
