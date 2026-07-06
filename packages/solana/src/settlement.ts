import { transferChecked } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
} from '@solana/web3.js';
import type { X402Receipt } from './x402.js';
import { verifyX402ReceiptSignature } from './x402.js';
import {
  submitClientSettlementTx,
  verifyClientSettlementTx,
} from './client-settlement.js';
import {
  ensureGhstSettlementAccounts,
  getFeeCollectorGhstAta,
  getGhstMint,
  getMintDecimals,
  getPayerGhstAta,
  getTokenAccountBalanceRaw,
  resolveTokenProgram,
} from './tokens.js';
import { loadDevWallet } from './wallet.js';
import { lookupSettledNonce, recordSettledNonce } from './nonce-store.js';

export function isSettlementEnabled(): boolean {
  return process.env.SOLANA_SETTLEMENT_ENABLED === 'true';
}

function resolvePayerKeypair(receipt: X402Receipt, payer?: Keypair): Keypair | null {
  if (payer) return payer;
  if (process.env.DEV_X402_SIGN !== 'true') return null;
  try {
    const dev = loadDevWallet();
    if (dev.publicKey.toBase58() === receipt.payer) return dev;
  } catch {
    return null;
  }
  return null;
}

export interface SettleGhstResult {
  signature: string;
  amount: bigint;
  destination: string;
}

export interface SettleGhstOptions {
  payer?: Keypair;
  /** Base64 signed tx from client wallet (production path). */
  settlementTx?: string;
}

/**
 * Transfer GHST on-chain for a validated x402 receipt.
 * Client path: verify + submit pre-signed tx. Dev path: server signs transfer.
 */
export async function settleGhstFromReceipt(
  connection: Connection,
  receipt: X402Receipt,
  opts?: SettleGhstOptions,
): Promise<SettleGhstResult | null> {
  if (!verifyX402ReceiptSignature(receipt)) return null;

  const existing = await lookupSettledNonce(receipt.nonce);
  if (existing) {
    return {
      signature: existing.tx_signature,
      amount: BigInt(receipt.amount),
      destination: receipt.recipient,
    };
  }

  const amount = BigInt(receipt.amount);
  if (amount <= 0n) return null;

  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const destination = getFeeCollectorGhstAta(tokenProgram);
  if (destination.toBase58() !== receipt.recipient) {
    console.error('[settlement] Receipt recipient mismatch', receipt.recipient, destination.toBase58());
    return null;
  }

  let signature: string;

  if (opts?.settlementTx) {
    const verified = await verifyClientSettlementTx(connection, receipt, opts.settlementTx);
    if (!verified.ok) {
      console.error('[settlement] Client tx verification failed:', verified.reason);
      return null;
    }
    signature = await submitClientSettlementTx(connection, opts.settlementTx);
  } else {
    const payerKp = resolvePayerKeypair(receipt, opts?.payer);
    if (!payerKp) {
      console.error('[settlement] No payer keypair — send settlement_tx from client wallet');
      return null;
    }

    await ensureGhstSettlementAccounts(connection, payerKp);

    const sourceAta = getPayerGhstAta(payerKp.publicKey, tokenProgram);
    const balance = await getTokenAccountBalanceRaw(connection, sourceAta);
    if (balance < amount) {
      console.error(`[settlement] Insufficient GHST: have ${balance}, need ${amount}`);
      return null;
    }

    const decimals = await getMintDecimals(connection, mint, tokenProgram);
    signature = await transferChecked(
      connection,
      payerKp,
      sourceAta,
      mint,
      destination,
      payerKp.publicKey,
      amount,
      decimals,
      [],
      undefined,
      tokenProgram,
    );
  }

  const recorded = await recordSettledNonce(
    receipt.nonce,
    receipt.payer,
    receipt.amount,
    signature,
  );
  if (recorded === 'duplicate') {
    const dup = await lookupSettledNonce(receipt.nonce);
    return {
      signature: dup?.tx_signature ?? signature,
      amount,
      destination: destination.toBase58(),
    };
  }

  console.log(`[settlement] GHST transfer ${amount} → ${destination.toBase58()} tx=${signature}`);
  return { signature, amount, destination: destination.toBase58() };
}

/** Build + send a standalone GHST transfer (testing / setup). */
export async function transferGhst(
  connection: Connection,
  payer: Keypair,
  amount: bigint,
  destination?: PublicKey,
): Promise<string> {
  const mint = getGhstMint();
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const dest = destination ?? getFeeCollectorGhstAta(tokenProgram);
  await ensureGhstSettlementAccounts(connection, payer);

  const sourceAta = getPayerGhstAta(payer.publicKey, tokenProgram);
  const decimals = await getMintDecimals(connection, mint, tokenProgram);

  return transferChecked(
    connection,
    payer,
    sourceAta,
    mint,
    dest,
    payer.publicKey,
    amount,
    decimals,
    [],
    undefined,
    tokenProgram,
  );
}
