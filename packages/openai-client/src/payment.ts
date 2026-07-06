import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  buildDevX402Receipt,
  encodeX402Payment,
} from '@ghost-compute/solana';
import type { X402Accept } from './types.js';

async function resolveTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  return info.owner;
}

/** Build X-Payment header: signed receipt + client-signed GHST transfer tx. */
export async function buildX402PaymentHeader(
  connection: Connection,
  payer: Keypair,
  accept: X402Accept,
): Promise<string> {
  const amount = accept.maxAmountRequired ?? '0';
  const recipient = accept.payTo ?? '';
  const asset = accept.asset ?? '';
  if (!amount || amount === '0' || !recipient || !asset) {
    throw new Error('Invalid x402 accept: missing amount, payTo, or asset');
  }

  const mint = new PublicKey(asset);
  const destination = new PublicKey(recipient);
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const sourceAta = getAssociatedTokenAddressSync(mint, payer.publicKey, false, tokenProgram);
  const mintAccount = await getMint(connection, mint, undefined, tokenProgram);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      sourceAta,
      payer.publicKey,
      mint,
      tokenProgram,
    ),
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destination,
      payer.publicKey,
      BigInt(amount),
      mintAccount.decimals,
      [],
      tokenProgram,
    ),
  );
  tx.sign(payer);
  const settlementTx = Buffer.from(tx.serialize()).toString('base64');

  const receipt = buildDevX402Receipt(payer, recipient, asset, amount);
  return encodeX402Payment({ receipt, settlement_tx: settlementTx });
}
