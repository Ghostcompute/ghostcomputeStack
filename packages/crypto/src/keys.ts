// P2 — Enclave key material
// Helpers for generating and (de)serializing the X25519 keypair that a worker's
// enclave publishes via attestation. The service publishes per-worker enclave pubkeys;
// the worker decrypts only inside the enclave with the matching private key.

import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

export interface EnclaveKeypair {
  publicKey: Uint8Array; // 32 bytes (X25519)
  privateKey: Uint8Array; // 32 bytes
}

/** Generate a fresh X25519 enclave keypair. Private key never leaves the enclave. */
export function generateEnclaveKeypair(): EnclaveKeypair {
  const privateKey = x25519.utils.randomPrivateKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Derive the public key from a raw 32-byte private key. */
export function enclavePublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

export const toHex = (b: Uint8Array): string => bytesToHex(b);
export const fromHex = (h: string): Uint8Array => hexToBytes(h.replace(/^0x/, ''));

/** Random bytes helper (audited CSPRNG via @noble). */
export const random = (n: number): Uint8Array => randomBytes(n);
