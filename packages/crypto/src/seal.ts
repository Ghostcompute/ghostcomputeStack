// P2 — Client-side sealing
// Encrypt model/prompt/order payloads TO the enclave public key so plaintext
// never leaves the client unencrypted. Hybrid ECIES:
//   1. ephemeral X25519 keypair
//   2. ECDH(ephemeral_priv, enclave_pub) → shared secret
//   3. HKDF-SHA256(shared) → 32-byte AEAD key
//   4. XChaCha20-Poly1305 with a random 24-byte nonce
//
// Wire format (all binary, concatenated):
//   [ magic(4) | ephemeral_pub(32) | nonce(24) | ciphertext+tag(N) ]
//   = 60 bytes overhead + plaintext length.
//
// Only the enclave holding the matching X25519 private key can unseal — and per
// spec Part VII the Vercel control plane only ever sees this ciphertext.

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';

const MAGIC = new Uint8Array([0x47, 0x53, 0x4c, 0x31]); // "GSL1" — Ghost Seal v1
const EPK_LEN = 32;
const NONCE_LEN = 24;
const HEADER_LEN = MAGIC.length + EPK_LEN + NONCE_LEN; // 60

// HKDF context binds the derived key to this protocol + recipient.
const HKDF_INFO = new TextEncoder().encode('ghost-compute/seal/v1');

function deriveKey(sharedSecret: Uint8Array, ephemeralPub: Uint8Array, enclavePub: Uint8Array): Uint8Array {
  // Salt = ephemeral_pub || enclave_pub, so the key is bound to both parties.
  const salt = new Uint8Array(EPK_LEN * 2);
  salt.set(ephemeralPub, 0);
  salt.set(enclavePub, EPK_LEN);
  return hkdf(sha256, sharedSecret, salt, HKDF_INFO, 32);
}

/**
 * Seal plaintext to an enclave's X25519 public key (32 bytes).
 * Returns the self-describing sealed blob (see wire format above).
 */
export async function sealInput(
  plaintext: Uint8Array,
  enclavePublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (enclavePublicKey.length !== EPK_LEN) {
    throw new Error(`sealInput: enclave public key must be ${EPK_LEN} bytes`);
  }

  const ephemeralPriv = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const shared = x25519.getSharedSecret(ephemeralPriv, enclavePublicKey);
  const key = deriveKey(shared, ephemeralPub, enclavePublicKey);

  const nonce = randomBytes(NONCE_LEN);
  // AAD binds the header (magic+epk+nonce) into the tag — tamper-evident.
  const header = new Uint8Array(HEADER_LEN);
  header.set(MAGIC, 0);
  header.set(ephemeralPub, MAGIC.length);
  header.set(nonce, MAGIC.length + EPK_LEN);

  const aead = xchacha20poly1305(key, nonce, header);
  const ciphertext = aead.encrypt(plaintext);

  const out = new Uint8Array(HEADER_LEN + ciphertext.length);
  out.set(header, 0);
  out.set(ciphertext, HEADER_LEN);
  return out;
}

/**
 * Unseal a blob inside the enclave using its X25519 private key (32 bytes).
 * Fails closed (throws) on any tampering, wrong key, or malformed input — the
 * caller must NEVER fall back to treating the payload as plaintext.
 */
export async function unsealOutput(
  sealed: Uint8Array,
  enclavePrivateKey: Uint8Array,
): Promise<Uint8Array> {
  if (sealed.length < HEADER_LEN) {
    throw new Error('unsealOutput: sealed blob too short');
  }
  const magic = sealed.subarray(0, MAGIC.length);
  if (!magic.every((b, i) => b === MAGIC[i])) {
    throw new Error('unsealOutput: bad magic / not a ghost-seal blob');
  }

  const ephemeralPub = sealed.subarray(MAGIC.length, MAGIC.length + EPK_LEN);
  const nonce = sealed.subarray(MAGIC.length + EPK_LEN, HEADER_LEN);
  const header = sealed.subarray(0, HEADER_LEN);
  const ciphertext = sealed.subarray(HEADER_LEN);

  const enclavePub = x25519.getPublicKey(enclavePrivateKey);
  const shared = x25519.getSharedSecret(enclavePrivateKey, ephemeralPub);
  const key = deriveKey(shared, ephemeralPub, enclavePub);

  const aead = xchacha20poly1305(key, nonce, header);
  // Throws on auth-tag mismatch — this is the fail-closed boundary.
  return aead.decrypt(ciphertext);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Convenience: seal a UTF-8 string. */
export async function sealString(plaintext: string, enclavePublicKey: Uint8Array): Promise<Uint8Array> {
  return sealInput(enc.encode(plaintext), enclavePublicKey);
}

/** Convenience: unseal to a UTF-8 string. */
export async function unsealString(sealed: Uint8Array, enclavePrivateKey: Uint8Array): Promise<string> {
  return dec.decode(await unsealOutput(sealed, enclavePrivateKey));
}
