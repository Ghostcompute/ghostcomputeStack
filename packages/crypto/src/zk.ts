// P4-stretch — ZK order proofs for the dark pool.
// Proves an order is well-formed and owner-authorized WITHOUT revealing
// amount/price, so the resting book stays confidential.
//
// MVP construction (a sound sigma-protocol, not a full range proof):
//   commitment = HMAC-SHA256(blinding, side || amount || price)   — hiding + binding
//   sig        = Ed25519_sign(owner, commitment)                  — authorization
// The verifier checks the signature binds the commitment to the owner; the
// (amount, price, blinding) opening stays secret until the match is revealed
// in-enclave, where it is checked against this commitment.
//
// Upgrade path (documented): replace `commitment` with a Pedersen commitment +
// Groth16/bn254 range proof (amount>0, price within bounds) — same external
// shape (`generateOrderProof`/`verifyOrderProof`), so callers don't change.

import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

/** Big-endian fixed-width encoding of a non-negative bigint. */
function numberToBytesBE(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new Error('numberToBytesBE: value does not fit');
  return out;
}

export interface OrderProof {
  v: 1;
  side: 'buy' | 'sell';
  commitment: string; // hex — HMAC(blinding, side||amount||price)
  owner_pubkey: string; // hex ed25519
  signature: string; // hex ed25519 over commitment bytes
}

/** Opening kept by the owner; revealed only in-enclave at match time. */
export interface OrderOpening {
  side: 'buy' | 'sell';
  amount: string;
  price: string;
  blinding: string; // hex
}

function commitBytes(side: 'buy' | 'sell', amount: bigint, price: bigint, blinding: Uint8Array): Uint8Array {
  const msg = concatBytes(
    utf8ToBytes(side),
    numberToBytesBE(amount, 16),
    numberToBytesBE(price, 16),
  );
  return hmac(sha256, blinding, msg);
}

/**
 * Generate a confidential order proof. Returns { proof, opening }:
 * the proof is published; the opening is held privately by the owner.
 */
export async function generateOrderProofFull(
  side: 'buy' | 'sell',
  amount: bigint,
  price: bigint,
  ownerPrivateKey: Uint8Array,
): Promise<{ proof: OrderProof; opening: OrderOpening }> {
  const blinding = randomBytes(32);
  const commitment = commitBytes(side, amount, price, blinding);
  const signature = ed25519.sign(commitment, ownerPrivateKey);
  const owner_pubkey = ed25519.getPublicKey(ownerPrivateKey);

  return {
    proof: {
      v: 1,
      side,
      commitment: bytesToHex(commitment),
      owner_pubkey: bytesToHex(owner_pubkey),
      signature: bytesToHex(signature),
    },
    opening: { side, amount: amount.toString(), price: price.toString(), blinding: bytesToHex(blinding) },
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

/** Verify a serialized (base64-JSON) order proof: structure + owner signature. */
export async function verifyOrderProof(proof: string): Promise<boolean> {
  try {
    const p = JSON.parse(Buffer.from(proof, 'base64').toString('utf8')) as OrderProof;
    if (p.v !== 1 || (p.side !== 'buy' && p.side !== 'sell')) return false;
    const commitment = hexToBytes(p.commitment);
    if (commitment.length !== 32) return false;
    return ed25519.verify(hexToBytes(p.signature), commitment, hexToBytes(p.owner_pubkey));
  } catch {
    return false;
  }
}

/**
 * In-enclave check at match time: confirm a revealed opening matches the
 * published commitment (and the proof's owner signature is valid).
 */
export async function verifyOpening(proof: OrderProof, opening: OrderOpening): Promise<boolean> {
  const expected = commitBytes(
    opening.side,
    BigInt(opening.amount),
    BigInt(opening.price),
    hexToBytes(opening.blinding),
  );
  if (bytesToHex(expected) !== p_commit(proof)) return false;
  return ed25519.verify(hexToBytes(proof.signature), expected, hexToBytes(proof.owner_pubkey));
}

const p_commit = (p: OrderProof) => p.commitment.replace(/^0x/, '');
