/**
 * Browser wallet helpers for x402 GHST payment.
 */
import { ed25519 } from '@noble/curves/ed25519';
import {
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

export interface WalletProvider {
  publicKey: PublicKey;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export interface X402ReceiptFields {
  amount: string;
  payer: string;
  recipient: string;
  asset: string;
  nonce: string;
  expires_at: number;
}

export interface X402ChallengeAccept {
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
  extra?: { jobId?: string };
}

function receiptMessage(receipt: X402ReceiptFields): Uint8Array {
  const payload = [
    receipt.amount,
    receipt.payer,
    receipt.recipient,
    receipt.asset,
    receipt.nonce,
    String(receipt.expires_at),
  ].join('|');
  return new TextEncoder().encode(payload);
}

export async function signX402ReceiptWithWallet(
  wallet: WalletProvider,
  fields: Omit<X402ReceiptFields, 'payer' | 'signature'>,
): Promise<X402ReceiptFields & { signature: string }> {
  const payer = wallet.publicKey.toBase58();
  const body: X402ReceiptFields = { ...fields, payer };
  const sigBytes = await wallet.signMessage(receiptMessage(body));
  return { ...body, signature: bs58.encode(sigBytes) };
}

async function resolveTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint not found: ${mint.toBase58()}`);
  return info.owner;
}

async function getMintDecimals(connection: Connection, mint: PublicKey, tokenProgram: PublicKey): Promise<number> {
  const { getMint } = await import('@solana/spl-token');
  const mintInfo = await getMint(connection, mint, undefined, tokenProgram);
  return mintInfo.decimals;
}

/** Build + sign GHST transfer tx; returns base64 serialized payment envelope header. */
export async function buildWalletX402Payment(
  connection: Connection,
  wallet: WalletProvider,
  accept: X402ChallengeAccept,
): Promise<string> {
  const amount = accept.maxAmountRequired ?? '0';
  const recipient = accept.payTo ?? '';
  const asset = accept.asset ?? '';
  const payer = wallet.publicKey;
  const mint = new PublicKey(asset);
  const destination = new PublicKey(recipient);
  const tokenProgram = await resolveTokenProgram(connection, mint);
  const splToken = await import('@solana/spl-token');
  const { getAssociatedTokenAddressSync, createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } = splToken;

  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, tokenProgram);
  const payerAta = sourceAta;
  const decimals = await getMintDecimals(connection, mint, tokenProgram);

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    payerAta,
    payer,
    mint,
    tokenProgram,
  );

  const transferIx = createTransferCheckedInstruction(
    sourceAta,
    mint,
    destination,
    payer,
    BigInt(amount),
    decimals,
    [],
    tokenProgram,
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer });
  tx.add(createAtaIx, transferIx);

  const signedTx = await wallet.signTransaction(tx);
  const settlementTx = Buffer.from(signedTx.serialize()).toString('base64');

  const receipt = await signX402ReceiptWithWallet(wallet, {
    amount,
    recipient,
    asset,
    nonce: crypto.randomUUID(),
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });

  const payment = { receipt, settlement_tx: settlementTx };
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

export function getWalletProvider(): WalletProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: {
      publicKey?: PublicKey;
      connect(): Promise<{ publicKey: PublicKey }>;
      signMessage(msg: Uint8Array): Promise<{ signature: Uint8Array }>;
      signTransaction(tx: Transaction): Promise<Transaction>;
    } };
    solflare?: {
      publicKey?: PublicKey;
      connect(): Promise<{ publicKey: PublicKey }>;
      signMessage(msg: Uint8Array): Promise<{ signature: Uint8Array }>;
      signTransaction(tx: Transaction): Promise<Transaction>;
    };
  };

  const provider = w.phantom?.solana ?? w.solflare ?? null;
  if (!provider) return null;

  return {
    get publicKey() {
      if (!provider.publicKey) throw new Error('Wallet not connected');
      return provider.publicKey;
    },
    async signMessage(message: Uint8Array) {
      const { signature } = await provider.signMessage(message);
      return signature;
    },
    async signTransaction(tx: Transaction) {
      return provider.signTransaction(tx);
    },
  };
}

export async function connectWalletProvider(): Promise<WalletProvider> {
  const w = window as unknown as {
    phantom?: { solana?: { connect(): Promise<{ publicKey: PublicKey }>; publicKey?: PublicKey; signMessage(msg: Uint8Array): Promise<{ signature: Uint8Array }>; signTransaction(tx: Transaction): Promise<Transaction> } };
    solflare?: { connect(): Promise<{ publicKey: PublicKey }>; publicKey?: PublicKey; signMessage(msg: Uint8Array): Promise<{ signature: Uint8Array }>; signTransaction(tx: Transaction): Promise<Transaction> };
  };
  const provider = w.phantom?.solana ?? w.solflare;
  if (!provider) throw new Error('Install Phantom or Solflare');

  await provider.connect();
  return {
    get publicKey() {
      if (!provider.publicKey) throw new Error('Wallet not connected');
      return provider.publicKey;
    },
    async signMessage(message: Uint8Array) {
      const { signature } = await provider.signMessage(message);
      return signature;
    },
    async signTransaction(tx: Transaction) {
      return provider.signTransaction(tx);
    },
  };
}

export async function fetchX402Config(apiBase: string): Promise<{ rpc: string; ghstMint: string; payTo: string }> {
  const res = await fetch(`${apiBase.replace(/\/$/, '')}/api/x402/config`);
  if (!res.ok) throw new Error('Failed to load x402 config');
  return res.json();
}

/** Verify ed25519 receipt signature locally (optional UI feedback). */
export function verifyReceiptSignature(receipt: X402ReceiptFields & { signature: string }): boolean {
  try {
    const pubkey = bs58.decode(receipt.payer);
    const sig = bs58.decode(receipt.signature);
    return ed25519.verify(sig, receiptMessage(receipt), pubkey);
  } catch {
    return false;
  }
}
