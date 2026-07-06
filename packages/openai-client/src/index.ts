export { GhostOpenAI, createGhostClient } from './client.js';
export { buildX402PaymentHeader } from './payment.js';
export { parseChatCompletionStream } from './stream.js';
export type {
  ChatCompletionChunk,
  ChatCompletionChoice,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ChatRole,
  GhostClientOptions,
  Guarantee,
  X402Accept,
  X402Challenge,
  X402Config,
} from './types.js';

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

/** Load a Solana keypair from a base58-encoded 64-byte secret (Phantom export / DEV_WALLET). */
export function keypairFromSecret(secret: string): Keypair {
  const decoded = bs58.decode(secret.trim());
  if (decoded.length !== 64) {
    throw new Error(`Secret key must decode to 64 bytes, got ${decoded.length}`);
  }
  return Keypair.fromSecretKey(decoded);
}
