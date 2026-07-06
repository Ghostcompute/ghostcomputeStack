import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Load keypair from DEV_WALLET (base58 64-byte secret) env var. */
export function loadDevWallet(): Keypair {
  const secret = process.env.DEV_WALLET?.trim();
  if (!secret) throw new Error('DEV_WALLET is not set');
  const decoded = bs58.decode(secret);
  if (decoded.length !== 64) {
    throw new Error(`DEV_WALLET must decode to 64 bytes, got ${decoded.length}`);
  }
  return Keypair.fromSecretKey(decoded);
}
