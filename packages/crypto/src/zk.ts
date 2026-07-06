// P4 — ZK order proofs for the dark pool.
// Proves an order is well-formed (amount>0, price>0, both within u64 range) and
// owner-authorized WITHOUT revealing amount/price, so the resting book stays
// confidential.
//
// Construction (real zero-knowledge, no trusted setup):
//   • Pedersen commitment on the ed25519 prime-order subgroup:
//         C = v·G + r·H          (G = base point, H = NUMS generator, dlog_G(H) unknown)
//     — perfectly hiding, computationally binding.
//   • Range proof v ∈ [1, 2^64): bit-decompose (v-1) into 64 bits, commit to each
//     bit, and prove every bit commitment opens to 0 or 1 with a non-interactive
//     Chaum–Pedersen OR-proof (Fiat–Shamir). The homomorphic sum of the bit
//     commitments (weighted by 2^i) must equal C - G, which forces v-1 ∈ [0,2^64)
//     ⇒ v ∈ [1, 2^64). Proving (v-1) rather than v also enforces v>0.
//   • sig = Ed25519_sign(owner, C_amount || C_price)  — owner authorization.
//
// The opening (v, r) is revealed only in-enclave at match time (verifyOpening),
// where it is checked against the published commitment. Same external shape as
// before (generateOrderProof / verifyOrderProof / verifyOpening), so callers are
// unchanged; the proof string is simply richer.

import { ed25519 } from '@noble/curves/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

const Point = ed25519.ExtendedPoint;
const G = Point.BASE;
const L = ed25519.CURVE.n; // prime group order
const BITS = 64; // u64 range

// ── scalar arithmetic (mod L) ────────────────────────────────────────────────
function bytesToNumberBE(b: Uint8Array): bigint {
  let v = 0n;
  for (const byte of b) v = (v << 8n) | BigInt(byte);
  return v;
}
const mod = (a: bigint): bigint => ((a % L) + L) % L;
function invL(a: bigint): bigint {
  // Fermat inverse: a^(L-2) mod L (L is prime).
  return powL(mod(a), L - 2n);
}
function powL(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % L;
    b = (b * b) % L;
    e >>= 1n;
  }
  return result;
}
function randScalar(): bigint {
  let s = 0n;
  while (s === 0n) s = mod(bytesToNumberBE(randomBytes(64)));
  return s;
}

// ── NUMS second generator H (dlog base G unknown) ────────────────────────────
// Try-and-increment hash-to-curve on a fixed domain, then clear the cofactor so
// H lies in the prime-order subgroup. Because H comes from hashing (not k·G for
// a known k), its discrete log relative to G is unknown — required for binding.
function deriveH(): InstanceType<typeof Point> {
  for (let ctr = 0; ctr < 256; ctr++) {
    const cand = sha256(concatBytes(utf8ToBytes('ghost-compute/pedersen/H/v1'), Uint8Array.from([ctr])));
    try {
      const p = Point.fromHex(bytesToHex(cand)).multiply(8n); // cofactor clear
      if (!p.equals(Point.ZERO)) return p;
    } catch {
      /* not a valid encoding — try next counter */
    }
  }
  throw new Error('deriveH: failed to derive generator');
}
const H = deriveH();

const commit = (v: bigint, r: bigint) =>
  (v === 0n ? Point.ZERO : G.multiply(v)).add(H.multiply(r));

// ── Fiat–Shamir challenge ────────────────────────────────────────────────────
function fsChallenge(...points: InstanceType<typeof Point>[]): bigint {
  const h = sha512(concatBytes(...points.map((p) => p.toRawBytes())));
  return mod(bytesToNumberBE(h));
}

// ── bit OR-proof: C commits to 0 or 1 (knowledge of dlog base H of C or C−G) ──
interface BitProof {
  c: string; // commitment C_i
  a0: string; a1: string; e0: string; e1: string; z0: string; z1: string;
}

function proveBit(bit: 0 | 1, r: bigint): BitProof {
  const C = commit(BigInt(bit), r);
  const P0 = C;            // if bit==0, C = r·H
  const P1 = C.subtract(G); // if bit==1, C−G = r·H
  let A0: InstanceType<typeof Point>, A1: InstanceType<typeof Point>;
  let e0: bigint, e1: bigint, z0: bigint, z1: bigint;

  if (bit === 0) {
    const k = randScalar();
    A0 = H.multiply(k);
    e1 = randScalar();
    z1 = randScalar();
    A1 = H.multiply(z1).subtract(P1.multiply(e1)); // simulated branch
    const e = fsChallenge(P0, P1, A0, A1);
    e0 = mod(e - e1);
    z0 = mod(k + e0 * r);
  } else {
    const k = randScalar();
    A1 = H.multiply(k);
    e0 = randScalar();
    z0 = randScalar();
    A0 = H.multiply(z0).subtract(P0.multiply(e0)); // simulated branch
    const e = fsChallenge(P0, P1, A0, A1);
    e1 = mod(e - e0);
    z1 = mod(k + e1 * r);
  }
  return {
    c: bytesToHex(C.toRawBytes()),
    a0: bytesToHex(A0.toRawBytes()), a1: bytesToHex(A1.toRawBytes()),
    e0: e0.toString(16), e1: e1.toString(16),
    z0: z0.toString(16), z1: z1.toString(16),
  };
}

function verifyBit(bp: BitProof): boolean {
  try {
    const C = Point.fromHex(bp.c);
    const P0 = C;
    const P1 = C.subtract(G);
    const A0 = Point.fromHex(bp.a0);
    const A1 = Point.fromHex(bp.a1);
    const e0 = mod(BigInt('0x' + bp.e0));
    const e1 = mod(BigInt('0x' + bp.e1));
    const z0 = mod(BigInt('0x' + bp.z0));
    const z1 = mod(BigInt('0x' + bp.z1));
    const e = fsChallenge(P0, P1, A0, A1);
    if (mod(e0 + e1) !== e) return false;
    // z0·H == A0 + e0·P0  and  z1·H == A1 + e1·P1
    if (!H.multiply(z0).equals(A0.add(P0.multiply(e0)))) return false;
    if (!H.multiply(z1).equals(A1.add(P1.multiply(e1)))) return false;
    return true;
  } catch {
    return false;
  }
}

// ── range proof for value ∈ [1, 2^BITS) via commitment C = v·G + r·H ─────────
interface RangeProof {
  bits: BitProof[]; // BITS bit-commitments proving (v-1) ∈ [0, 2^BITS)
}

/** Prove the commitment `C = v·G + r·H` opens to v ∈ [1, 2^BITS). */
function proveRange(v: bigint, r: bigint): RangeProof {
  if (v < 1n || v >= 1n << BigInt(BITS)) throw new Error('proveRange: value out of [1,2^64)');
  const w = v - 1n; // prove w ∈ [0, 2^BITS); commitment to w is C - G with blinding r
  const rBits: bigint[] = [];
  for (let i = 0; i < BITS - 1; i++) rBits.push(randScalar());
  // Force Σ 2^i r_i = r  ⇒  r_{last} = (r − Σ_{i<last} 2^i r_i) · (2^{last})^{-1}
  let acc = 0n;
  for (let i = 0; i < BITS - 1; i++) acc = mod(acc + (1n << BigInt(i)) * rBits[i]);
  const lastWeightInv = invL(1n << BigInt(BITS - 1));
  rBits.push(mod((r - acc) * lastWeightInv));

  const bits: BitProof[] = [];
  for (let i = 0; i < BITS; i++) {
    const b = ((w >> BigInt(i)) & 1n) === 1n ? 1 : 0;
    bits.push(proveBit(b as 0 | 1, rBits[i]));
  }
  return { bits };
}

/** Verify a range proof against commitment `C` (value proven ∈ [1, 2^BITS)). */
function verifyRange(C: InstanceType<typeof Point>, rp: RangeProof): boolean {
  if (!rp || !Array.isArray(rp.bits) || rp.bits.length !== BITS) return false;
  let sum = Point.ZERO;
  for (let i = 0; i < BITS; i++) {
    const bp = rp.bits[i];
    if (!verifyBit(bp)) return false;
    const Ci = Point.fromHex(bp.c);
    sum = sum.add(Ci.multiply(1n << BigInt(i)));
  }
  // Σ 2^i C_i must equal the commitment to (v-1), i.e. C − G.
  return sum.equals(C.subtract(G));
}

// ── public API ───────────────────────────────────────────────────────────────
export interface OrderProof {
  v: 2;
  side: 'buy' | 'sell';
  c_amount: string; // Pedersen commitment to amount (hex)
  c_price: string;  // Pedersen commitment to price (hex)
  range_amount: RangeProof;
  range_price: RangeProof;
  owner_pubkey: string; // hex ed25519
  signature: string;    // hex ed25519 over (c_amount || c_price)
}

/** Opening kept by the owner; revealed only in-enclave at match time. */
export interface OrderOpening {
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  r_amount: string; // hex blinding for c_amount
  r_price: string;  // hex blinding for c_price
}

function scalarToHex(s: bigint): string {
  return s.toString(16).padStart(64, '0');
}

/**
 * Generate a confidential order proof. Returns { proof, opening }:
 * the proof (commitments + range proofs + owner sig) is published; the opening
 * (values + blindings) is held privately by the owner.
 */
export async function generateOrderProofFull(
  side: 'buy' | 'sell',
  amount: bigint,
  price: bigint,
  ownerPrivateKey: Uint8Array,
): Promise<{ proof: OrderProof; opening: OrderOpening }> {
  if (amount < 1n) throw new Error('generateOrderProof: amount must be > 0');
  if (price < 1n) throw new Error('generateOrderProof: price must be > 0');

  const rAmount = randScalar();
  const rPrice = randScalar();
  const cAmount = commit(amount, rAmount);
  const cPrice = commit(price, rPrice);

  const rangeAmount = proveRange(amount, rAmount);
  const rangePrice = proveRange(price, rPrice);

  const signedBytes = concatBytes(cAmount.toRawBytes(), cPrice.toRawBytes());
  const signature = ed25519.sign(signedBytes, ownerPrivateKey);
  const owner_pubkey = ed25519.getPublicKey(ownerPrivateKey);

  return {
    proof: {
      v: 2,
      side,
      c_amount: bytesToHex(cAmount.toRawBytes()),
      c_price: bytesToHex(cPrice.toRawBytes()),
      range_amount: rangeAmount,
      range_price: rangePrice,
      owner_pubkey: bytesToHex(owner_pubkey),
      signature: bytesToHex(signature),
    },
    opening: {
      side,
      amount: amount.toString(),
      price: price.toString(),
      r_amount: scalarToHex(rAmount),
      r_price: scalarToHex(rPrice),
    },
  };
}

/** Convenience matching the original contract: returns the base64 proof string. */
export async function generateOrderProof(
  side: 'buy' | 'sell',
  amount: bigint,
  price: bigint,
  ownerPrivateKey: Uint8Array,
): Promise<string> {
  const { proof } = await generateOrderProofFull(side, amount, price, ownerPrivateKey);
  return Buffer.from(JSON.stringify(proof), 'utf8').toString('base64');
}

/**
 * Verify a serialized (base64-JSON) order proof:
 *   • structural sanity + owner signature over the commitments (authorization),
 *   • both range proofs (amount>0, price>0, within u64) — WITHOUT learning either.
 */
export async function verifyOrderProof(proof: string): Promise<boolean> {
  try {
    const p = JSON.parse(Buffer.from(proof, 'base64').toString('utf8')) as OrderProof;
    if (p.v !== 2 || (p.side !== 'buy' && p.side !== 'sell')) return false;

    const cAmount = Point.fromHex(p.c_amount);
    const cPrice = Point.fromHex(p.c_price);

    // Owner authorization: signature binds the commitments to the owner key.
    const signedBytes = concatBytes(cAmount.toRawBytes(), cPrice.toRawBytes());
    if (!ed25519.verify(hexToBytes(p.signature), signedBytes, hexToBytes(p.owner_pubkey))) return false;

    // Confidential well-formedness: amount and price are strictly positive u64s.
    if (!verifyRange(cAmount, p.range_amount)) return false;
    if (!verifyRange(cPrice, p.range_price)) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * In-enclave check at match time: confirm a revealed opening matches the
 * published commitments (and the proof's owner signature is valid). This is
 * where the cleartext (amount, price) becomes known to the matcher.
 */
export async function verifyOpening(proof: OrderProof, opening: OrderOpening): Promise<boolean> {
  try {
    const amount = BigInt(opening.amount);
    const price = BigInt(opening.price);
    if (amount < 1n || price < 1n) return false;
    if (opening.side !== proof.side) return false;

    const rAmount = BigInt('0x' + opening.r_amount);
    const rPrice = BigInt('0x' + opening.r_price);
    const cAmount = commit(amount, rAmount);
    const cPrice = commit(price, rPrice);

    if (bytesToHex(cAmount.toRawBytes()) !== normHex(proof.c_amount)) return false;
    if (bytesToHex(cPrice.toRawBytes()) !== normHex(proof.c_price)) return false;

    const signedBytes = concatBytes(cAmount.toRawBytes(), cPrice.toRawBytes());
    return ed25519.verify(hexToBytes(proof.signature), signedBytes, hexToBytes(proof.owner_pubkey));
  } catch {
    return false;
  }
}

const normHex = (h: string) => h.replace(/^0x/, '').toLowerCase();

// ── standalone Pedersen commitment (used by confidential settlement, P6) ──────
// C = value·G + blinding·H — perfectly hiding (random blinding), computationally
// binding. Unlike a hash of the cleartext, the committed value cannot be
// brute-forced from C without the blinding, even for small amounts.
export function pedersenCommit(value: bigint, blindingHex?: string): { commitment: string; blinding: string } {
  if (value < 0n) throw new Error('pedersenCommit: value must be non-negative');
  const r = blindingHex ? mod(BigInt('0x' + blindingHex.replace(/^0x/, ''))) : randScalar();
  const C = commit(value, r);
  return { commitment: bytesToHex(C.toRawBytes()), blinding: scalarToHex(r) };
}

/** Re-open a Pedersen commitment: check C == value·G + blinding·H. */
export function pedersenVerify(commitmentHex: string, value: bigint, blindingHex: string): boolean {
  try {
    const r = mod(BigInt('0x' + blindingHex.replace(/^0x/, '')));
    return bytesToHex(commit(value, r).toRawBytes()) === normHex(commitmentHex);
  } catch {
    return false;
  }
}
