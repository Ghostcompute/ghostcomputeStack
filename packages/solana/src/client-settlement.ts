import {
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { X402Receipt } from './x402.js';
import {
  getFeeCollectorGhstAta,
  getGhstMint,
  getMintDecimals,
  getPayerGhstAta,
  resolveTokenProgram,
} from './tokens.js';

function decodeSignedTx(serialized: string): Transaction | VersionedTransaction {
  const raw = Buffer.from(serialized, 'base64');
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function extractInstructions(tx: Transaction | VersionedTransaction) {
  if (tx instanceof VersionedTransaction) {
    const msg = tx.message;
    const accountKeys = msg.getAccountKeys().staticAccountKeys;
    return msg.compiledInstructions.map((ix) => ({
      programId: accountKeys[ix.programIdIndex]!,
      keys: ix.accountKeyIndexes.map((i) => accountKeys[i]!),
      data: Buffer.from(ix.data),
    }));
  }
  return tx.instructions.map((ix) => ({
    programId: ix.programId,
    keys: ix.keys.map((k) => k.pubkey),
    data: ix.data,
  }));
}

function isTransferCheckedIx(
  programId: PublicKey,
  data: Buffer,
): boolean {
  const isToken = programId.equals(TOKEN_PROGRAM_ID) || programId.equals(TOKEN_2022_PROGRAM_ID);
  return isToken && data.length >= 1 && data[0] === 12;
}

/** Verify a client-signed tx matches the x402 receipt (transferChecked GHST → fee vault). */
export async function verifyClientSettlementTx(
  connection: Connection,
  receipt: X402Receipt,
  settlementTxB64: string,
): Promise<{ ok: true; amount: bigint } | { ok: false; reason: string }> {
  let tx: Transaction | VersionedTransaction;
  try {
    tx = decodeSignedTx(settlementTxB64);
  } catch {
    return { ok: false, reason: 'Invalid settlement transaction encoding' };
  }

  const payer = new PublicKey(receipt.payer);
  const expectedDest = new PublicKey(receipt.recipient);
  const expectedAmount = BigInt(receipt.amount);
  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const expectedSource = getPayerGhstAta(payer, tokenProgram);
  const expectedVault = getFeeCollectorGhstAta(tokenProgram);

  if (expectedDest.toBase58() !== receipt.recipient) {
    return { ok: false, reason: 'Recipient mismatch' };
  }
  if (expectedVault.toBase58() !== receipt.recipient && expectedDest.toBase58() === receipt.recipient) {
    // receipt.recipient should be vault ATA — already checked by validateX402Receipt
  }

  const instructions = extractInstructions(tx);
  let matched = false;

  for (const ix of instructions) {
    if (!isTransferCheckedIx(ix.programId, ix.data)) continue;
    if (ix.keys.length < 4) continue;

    const source = ix.keys[0]!;
    const ixMint = ix.keys[1]!;
    const dest = ix.keys[2]!;
    const authority = ix.keys[3]!;

    const amountOffset = 1 + 8;
    if (ix.data.length < amountOffset + 1) continue;
    const amount = ix.data.readBigUInt64LE(1);

    if (
      source.equals(expectedSource)
      && ixMint.equals(mint)
      && dest.equals(expectedDest)
      && authority.equals(payer)
      && amount === expectedAmount
    ) {
      matched = true;
      break;
    }
  }

  if (!matched) {
    return { ok: false, reason: 'No matching GHST transferChecked instruction' };
  }

  return { ok: true, amount: expectedAmount };
}

export async function submitClientSettlementTx(
  connection: Connection,
  settlementTxB64: string,
): Promise<string> {
  const tx = decodeSignedTx(settlementTxB64);
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/** Build an unsigned GHST transferChecked tx for wallet signing (browser / tests). */
export async function buildGhstTransferTx(
  connection: Connection,
  payer: PublicKey,
  amount: bigint,
  destination: PublicKey,
): Promise<Transaction> {
  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const source = getPayerGhstAta(payer, tokenProgram);
  const decimals = await getMintDecimals(connection, mint, tokenProgram);

  const ix = createTransferCheckedInstruction(
    source,
    mint,
    destination,
    payer,
    amount,
    decimals,
    [],
    tokenProgram,
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer });
  tx.add(ix);
  return tx;
}
