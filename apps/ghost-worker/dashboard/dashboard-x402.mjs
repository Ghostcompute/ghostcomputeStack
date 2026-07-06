/**
 * Browser wallet x402 payment for dashboard.html (ES module).
 * Uses jsDelivr ESM builds (esm.sh can fail in browser/iframe contexts).
 */
import { Connection, PublicKey, Transaction } from 'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.98.4/+esm';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from 'https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.8/+esm';
import { ed25519 } from 'https://cdn.jsdelivr.net/npm/@noble/curves@1.9.7/ed25519/+esm';
import bs58 from 'https://cdn.jsdelivr.net/npm/bs58@6.0.0/+esm';

const WALLET_STORAGE_KEY = 'ghost.wallet';

function receiptMessage(receipt) {
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

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function getInjectedProvider(kind) {
  if (kind === 'phantom') {
    return (window.phantom && window.phantom.solana)
      || (window.solana && window.solana.isPhantom ? window.solana : null);
  }
  return window.solflare && window.solflare.isSolflare ? window.solflare : window.solflare;
}

export function getConnectedWalletProvider() {
  let saved = null;
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
    async signMessage(message) {
      const res = await provider.signMessage(message, 'utf8');
      const sig = res?.signature ?? res;
      return sig instanceof Uint8Array ? sig : new Uint8Array(sig);
    },
    async signTransaction(tx) {
      return provider.signTransaction(tx);
    },
  };
}

async function signReceipt(wallet, fields) {
  const payer = wallet.publicKey.toBase58();
  const body = { ...fields, payer };
  const sigBytes = await wallet.signMessage(receiptMessage(body));
  return { ...body, signature: bs58.encode(sigBytes) };
}

export async function buildWalletX402Payment(accept) {
  const wallet = getConnectedWalletProvider();
  if (!wallet) throw new Error('Connect Phantom or Solflare first');

  const configRes = await fetch('/api/x402/config');
  if (!configRes.ok) throw new Error('x402 config unavailable');
  const config = await configRes.json();

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
