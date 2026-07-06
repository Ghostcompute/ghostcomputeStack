import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { findFeeVaultPda, getMintIds } from './program-ids.js';

export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };

export async function resolveTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  return info.owner;
}

export function getGhstMint(): PublicKey {
  return getMintIds().GHST;
}

/** SPL token account (ATA) that receives x402 GHST — owned by fee_vault PDA. */
export function getFeeCollectorGhstAta(tokenProgram = TOKEN_2022_PROGRAM_ID): PublicKey {
  const fromEnv = process.env.FEE_COLLECTOR_GHST_ATA?.trim();
  if (fromEnv) {
    try {
      return new PublicKey(fromEnv);
    } catch {
      // fall through
    }
  }
  const [feeVaultPda] = findFeeVaultPda();
  return getAssociatedTokenAddressSync(
    getGhstMint(),
    feeVaultPda,
    true,
    tokenProgram,
  );
}

export function getPayerGhstAta(
  owner: PublicKey,
  tokenProgram = TOKEN_2022_PROGRAM_ID,
): PublicKey {
  return getAssociatedTokenAddressSync(
    getGhstMint(),
    owner,
    false,
    tokenProgram,
  );
}

export async function getMintDecimals(
  connection: Connection,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<number> {
  const mintInfo = await getMint(connection, mint, undefined, tokenProgram);
  return mintInfo.decimals;
}

export async function getTokenAccountBalanceRaw(
  connection: Connection,
  tokenAccount: PublicKey,
): Promise<bigint> {
  try {
    const bal = await connection.getTokenAccountBalance(tokenAccount);
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

/** Create payer + fee-vault GHST ATAs if missing. Returns fee vault ATA address. */
export async function ensureGhstSettlementAccounts(
  connection: Connection,
  payer: Keypair,
): Promise<{ feeVaultAta: PublicKey; payerAta: PublicKey; tokenProgram: PublicKey }> {
  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const [feeVaultPda] = findFeeVaultPda();
  const feeVaultAta = getFeeCollectorGhstAta(tokenProgram);
  const payerAta = getPayerGhstAta(payer.publicKey, tokenProgram);

  const ix = [
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      feeVaultAta,
      feeVaultPda,
      mint,
      tokenProgram,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      payerAta,
      payer.publicKey,
      mint,
      tokenProgram,
    ),
  ];

  const tx = new Transaction().add(...ix);
  await sendAndConfirmTransaction(connection, tx, [payer], { commitment: 'confirmed' });

  return { feeVaultAta, payerAta, tokenProgram };
}
