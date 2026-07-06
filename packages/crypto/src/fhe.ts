// P5 — Homomorphic encryption layer for the confidential dark-pool order book.
// This package provides the encryption; the matcher operates over it inside the TEE
// (and, for MaxTrustSplit, delegates to Arcium MPC).
//
// Implements EXPONENTIAL ElGamal on ed25519 — additively homomorphic:
//   Enc(a) ⊕ Enc(b) = Enc(a + b)
// so the matcher can aggregate sealed volumes/notionals without decrypting
// individual orders. Values are encrypted "in the exponent" (m·G); recovering m
// needs a discrete log (feasible only for small bounded tallies), which is by
// design — comparison/clearing happens in-enclave or via Arcium.
//
// Real homomorphic addition is implemented and tested here. The full FHE
// comparison circuit for cross-order matching is delegated (Arcium) — see
// computeEncrypted. This is the "real interface, swap-not-rewrite" the plan asks
// for.

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

const Point = ed25519.ExtendedPoint;
const G = Point.BASE;
const L = ed25519.CURVE.n; // group order

function randScalar(): bigint {
  // Uniform-ish nonzero scalar mod L.
  let s = 0n;
  while (s === 0n) {
    const b = randomBytes(32);
    let v = 0n;
    for (const byte of b) v = (v << 8n) | BigInt(byte);
    s = v % L;
  }
  return s;
}

export interface FheKeypair {
  secretKey: bigint;
  publicKey: Uint8Array; // 32-byte compressed point
}

export interface FheCiphertext {
  c1: Uint8Array; // r·G
  c2: Uint8Array; // m·G + r·P
}

/** Generate an ElGamal keypair for an order-book column (held by the enclave). */
export function fheKeygen(): FheKeypair {
  const secretKey = randScalar();
  const publicKey = G.multiply(secretKey).toRawBytes();
  return { secretKey, publicKey };
}

/** Encrypt a non-negative integer value to a book public key. */
export function fheEncrypt(value: bigint, publicKey: Uint8Array): FheCiphertext {
  if (value < 0n) throw new Error('fheEncrypt: value must be non-negative');
  const P = Point.fromHex(bytesToHex(publicKey));
  const r = randScalar();
  const c1 = G.multiply(r);
  const mG = value === 0n ? Point.ZERO : G.multiply(value);
  const c2 = mG.add(P.multiply(r));
  return { c1: c1.toRawBytes(), c2: c2.toRawBytes() };
}

/** Homomorphic addition: Enc(a) ⊕ Enc(b) = Enc(a+b). */
export function fheAdd(a: FheCiphertext, b: FheCiphertext): FheCiphertext {
  const c1 = Point.fromHex(bytesToHex(a.c1)).add(Point.fromHex(bytesToHex(b.c1)));
  const c2 = Point.fromHex(bytesToHex(a.c2)).add(Point.fromHex(bytesToHex(b.c2)));
  return { c1: c1.toRawBytes(), c2: c2.toRawBytes() };
}

/** Decrypt to the curve point m·G (caller solves the small-range DLP if needed). */
export function fheDecryptToPoint(ct: FheCiphertext, secretKey: bigint): Uint8Array {
  const c1 = Point.fromHex(bytesToHex(ct.c1));
  const c2 = Point.fromHex(bytesToHex(ct.c2));
  const mG = c2.subtract(c1.multiply(secretKey));
  return mG.toRawBytes();
}

/**
 * Recover a small bounded value via baby-step discrete log (for tallies/counts
 * known to be ≤ maxValue). Returns null if not found in range.
 */
export function fheDecryptSmall(ct: FheCiphertext, secretKey: bigint, maxValue = 1_000_000): bigint | null {
  const target = fheDecryptToPoint(ct, secretKey);
  let acc = Point.ZERO;
  for (let m = 0; m <= maxValue; m++) {
    if (acc.toRawBytes().every((b, i) => b === target[i])) return BigInt(m);
    acc = acc.add(G);
  }
  return null;
}

// ── Serialization (wire/storage) ─────────────────────────────────────────────

export function serializeCiphertext(ct: FheCiphertext): string {
  return `${bytesToHex(ct.c1)}.${bytesToHex(ct.c2)}`;
}
export function deserializeCiphertext(s: string): FheCiphertext {
  const [c1, c2] = s.split('.');
  return { c1: hexToBytes(c1), c2: hexToBytes(c2) };
}

// ── Legacy/contract-compatible byte API (used by callers passing opaque bytes) ─

/** Encrypt opaque bytes as a length-prefixed sequence of ElGamal-encrypted
 *  bytes. Additively homomorphic per-byte; mainly for the book column values. */
export async function encryptInput(plaintext: Uint8Array, publicKey: Uint8Array): Promise<Uint8Array> {
  const parts = Array.from(plaintext).map((b) => serializeCiphertext(fheEncrypt(BigInt(b), publicKey)));
  return new TextEncoder().encode(JSON.stringify(parts));
}

export async function decryptOutput(ciphertext: Uint8Array, secretKey: bigint): Promise<Uint8Array> {
  const parts = JSON.parse(new TextDecoder().decode(ciphertext)) as string[];
  return Uint8Array.from(parts.map((s) => Number(fheDecryptSmall(deserializeCiphertext(s), secretKey, 255) ?? 0)));
}

/**
 * Homomorphic aggregation over an encrypted order-book column — the FHE
 * computation the enclave CAN do without decrypting: given many per-order
 * ElGamal ciphertexts (as produced by `encryptInput`, or a JSON array of
 * serialized ciphertexts), it returns Enc(Σ values) via repeated `fheAdd`. No
 * secret key is involved and no operand is ever decrypted — the aggregate can
 * be opened later, in-enclave, with `fheDecryptSmall`.
 *
 * This backs the confidential dark-pool's sealed-volume / notional tallies.
 * The one operation exponential-ElGamal cannot do alone is a *comparison*
 * (price-cross / fill sizing over encrypted operands); that is delegated to the
 * MaxTrustSplit MPC backend — see apps/web/src/server/darkpool/arcium.ts
 * (`mpcMatch`), which uses this same ciphertext encoding. Same "real interface,
 * swap-not-rewrite" contract the plan asks for.
 */
export async function computeEncrypted(
  encryptedInput: Uint8Array,
  _arciumJobId?: string,
): Promise<Uint8Array> {
  let parts: string[];
  try {
    parts = JSON.parse(new TextDecoder().decode(encryptedInput)) as string[];
  } catch {
    throw new Error('computeEncrypted: input must be a JSON array of serialized ciphertexts');
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('computeEncrypted: empty encrypted input');
  }
  let acc = deserializeCiphertext(parts[0]);
  for (let i = 1; i < parts.length; i++) acc = fheAdd(acc, deserializeCiphertext(parts[i]));
  return new TextEncoder().encode(serializeCiphertext(acc));
}
