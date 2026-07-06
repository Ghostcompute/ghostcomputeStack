/**
 * Browser bundle entry for dashboard.html wallet x402 payments.
 */
import { ed25519 } from '@noble/curves/ed25519';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';

const WALLET_STORAGE_KEY = 'ghost.wallet';

function receiptMessage(receipt: {
  amount: string;
  payer: string;
  recipient: string;
  asset: string;
  nonce: string;
  expires_at: number;
}) {
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

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function getInjectedProvider(kind: string) {
  const w = window as Window & {
    phantom?: { solana?: { publicKey?: { toString(): string }; signMessage(m: Uint8Array, enc?: string): Promise<{ signature?: Uint8Array } | Uint8Array>; signTransaction(tx: Transaction): Promise<Transaction> } };
    solana?: { isPhantom?: boolean; publicKey?: { toString(): string }; signMessage(m: Uint8Array, enc?: string): Promise<{ signature?: Uint8Array } | Uint8Array>; signTransaction(tx: Transaction): Promise<Transaction> };
    solflare?: { isSolflare?: boolean; publicKey?: { toString(): string }; signMessage(m: Uint8Array, enc?: string): Promise<{ signature?: Uint8Array } | Uint8Array>; signTransaction(tx: Transaction): Promise<Transaction> };
  };
  if (kind === 'phantom') {
    return (w.phantom && w.phantom.solana)
      || (w.solana && w.solana.isPhantom ? w.solana : null);
  }
  return w.solflare && w.solflare.isSolflare ? w.solflare : w.solflare;
}

export function getConnectedWalletProvider() {
  let saved: { kind?: string } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(WALLET_STORAGE_KEY) || 'null');
  } catch {
    return null;
  }
  if (!saved?.kind) return null;

  const provider = getInjectedProvider(saved.kind);
  if (!provider?.publicKey) return null;

  const pubkey = provider.publicKey;
  return {
    kind: saved.kind,
    publicKey: pubkey instanceof PublicKey ? pubkey : new PublicKey(pubkey.toString()),
    async signMessage(message: Uint8Array) {
      const res = await provider.signMessage(message, 'utf8');
      const sig = (res as { signature?: Uint8Array })?.signature ?? res;
      return sig instanceof Uint8Array ? sig : new Uint8Array(sig as ArrayLike<number>);
    },
    async signTransaction(tx: Transaction) {
      return provider.signTransaction(tx);
    },
  };
}

async function signReceipt(
  wallet: NonNullable<ReturnType<typeof getConnectedWalletProvider>>,
  fields: { amount: string; recipient: string; asset: string; nonce: string; expires_at: number },
) {
  const payer = wallet.publicKey.toBase58();
  const body = { ...fields, payer };
  const sigBytes = await wallet.signMessage(receiptMessage(body));
  return { ...body, signature: bs58.encode(sigBytes) };
}

export async function buildWalletX402Payment(accept: {
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
}) {
  const wallet = getConnectedWalletProvider();
  if (!wallet) throw new Error('Connect Phantom or Solflare first');

  const configRes = await fetch('/api/x402/config');
  if (!configRes.ok) throw new Error('x402 config unavailable');
  const config = await configRes.json() as { rpc: string; ghstMint: string; payTo: string };

  const amount = accept.maxAmountRequired ?? '0';
  const recipient = accept.payTo ?? config.payTo;
  const asset = accept.asset ?? config.ghstMint;
  const mint = new PublicKey(asset);
  const destination = new PublicKey(recipient);
  const connection = new Connection(config.rpc, 'confirmed');

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error('GHST mint not found');
  const tokenProgram = mintInfo.owner;

  const payer = wallet.publicKey;
  const sourceAta = getAssociatedTokenAddressSync(mint, payer, false, tokenProgram);
  const mintAccount = await getMint(connection, mint, undefined, tokenProgram);
  const decimals = mintAccount.decimals;

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer });
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(payer, sourceAta, payer, mint, tokenProgram),
    createTransferCheckedInstruction(
      sourceAta, mint, destination, payer, BigInt(amount), decimals, [], tokenProgram,
    ),
  );

  const signedTx = await wallet.signTransaction(tx);
  const settlementTx = bytesToBase64(signedTx.serialize());

  const receipt = await signReceipt(wallet, {
    amount,
    recipient,
    asset,
    nonce: crypto.randomUUID(),
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });

  const payment = { receipt, settlement_tx: settlementTx };
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(payment)));
}
