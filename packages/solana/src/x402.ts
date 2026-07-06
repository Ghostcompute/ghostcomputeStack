import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export interface X402Receipt {
  amount: string;
  payer: string;
  recipient: string;
  asset: string;
  nonce: string;
  signature: string;
  expires_at: number;
}

export interface X402Challenge {
  x402Version: number;
  accepts: Array<{
    scheme: 'exact';
    network: 'solana-devnet' | 'solana-mainnet';
    maxAmountRequired: string;
    resource: string;
    description: string;
    mimeType: string;
    payTo: string;
    maxTimeoutSeconds: number;
    asset: string;
    extra: { name: string; version: string; jobId?: string };
  }>;
}

export function receiptMessage(receipt: Omit<X402Receipt, 'signature'>): Uint8Array {
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

export function signX402Receipt(
  fields: Omit<X402Receipt, 'signature'>,
  signer: Keypair,
): X402Receipt {
  const msg = receiptMessage(fields);
  const sig = ed25519.sign(msg, signer.secretKey.slice(0, 32));
  return { ...fields, signature: bs58.encode(sig) };
}

export function verifyX402ReceiptSignature(receipt: X402Receipt): boolean {
  try {
    const pubkey = new PublicKey(receipt.payer).toBytes();
    const sig = bs58.decode(receipt.signature);
    return ed25519.verify(sig, receiptMessage(receipt), pubkey);
  } catch {
    return false;
  }
}

export function makeX402Challenge(
  resource: string,
  payTo: string,
  maxAmount: string,
  asset: string,
  network: 'solana-devnet' | 'solana-mainnet' = 'solana-devnet',
  jobId?: string,
): X402Challenge {
  return {
    x402Version: 1,
    accepts: [{
      scheme: 'exact',
      network,
      maxAmountRequired: maxAmount,
      resource,
      description: 'Ghost Compute private inference',
      mimeType: 'application/json',
      payTo,
      maxTimeoutSeconds: 300,
      asset,
      extra: { name: 'GHST', version: '1', ...(jobId ? { jobId } : {}) },
    }],
  };
}

export function encodeX402Header(receipt: X402Receipt): string {
  return Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64');
}

export function parseX402Header(header: string | null): X402Receipt | null {
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    return JSON.parse(decoded) as X402Receipt;
  } catch {
    return null;
  }
}

export function validateX402Receipt(
  receipt: X402Receipt,
  opts: {
    minAmount: bigint;
    payTo: string;
    asset: string;
    nowSec?: number;
  },
): boolean {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (BigInt(receipt.amount) < opts.minAmount) return false;
  if (receipt.expires_at < now) return false;
  if (receipt.recipient !== opts.payTo) return false;
  if (receipt.asset !== opts.asset) return false;
  return verifyX402ReceiptSignature(receipt);
}

export function buildDevX402Receipt(
  payer: Keypair,
  payTo: string,
  asset: string,
  amount: string,
  ttlSec = 300,
): X402Receipt {
  return signX402Receipt({
    amount,
    payer: payer.publicKey.toBase58(),
    recipient: payTo,
    asset,
    nonce: randomUUID(),
    expires_at: Math.floor(Date.now() / 1000) + ttlSec,
  }, payer);
}
