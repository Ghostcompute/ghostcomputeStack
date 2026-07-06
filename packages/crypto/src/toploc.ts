// P4 — TOPLOC output commitment
// Paper: https://arxiv.org/abs/2501.16084
//
// Each inference response carries a 258-byte commitment binding the response to
// (model, input, output) without revealing the model or the input. This MVP
// implements the COMMITMENT + BINDING half of TOPLOC: a hiding, binding
// fixed-size commitment that a verifier can check for internal consistency and
// match against an independently-recomputed output hash.
//
// What it proves today: the worker committed to exactly these (model_hash,
// input_hash, output_hash) at generation time, tamper-evident as a unit.
// What is intentionally deferred: the locality-sensitive activation fingerprint
// from the paper that lets a verifier confirm the *committed model* actually
// produced the output. That requires the activation trace and is a drop-in
// upgrade to the `fingerprint` region below (kept zeroed + length-stable here).

import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils';

// 258-byte layout:
//   version            1
//   model_hash        32
//   input_hash        32
//   output_hash       32
//   salt              32   (hiding)
//   binding           32   = HMAC-SHA256(salt, version||model||input||output)
//   fingerprint       97   (reserved for LSH activation digest; zeroed in MVP)
//   ------------------------
//   total            258
export const TOPLOC_SIZE = 258;
const OFF = {
  version: 0,
  modelHash: 1,
  inputHash: 33,
  outputHash: 65,
  salt: 97,
  binding: 129,
  fingerprint: 161,
} as const;
const FINGERPRINT_LEN = TOPLOC_SIZE - OFF.fingerprint; // 97
const VERSION = 0x01;

export interface ToplockProof {
  commitment: Uint8Array; // 258 bytes
  model_hash: string;
  input_hash: string;
  output_hash: string;
}

function bindingTag(
  salt: Uint8Array,
  modelHash: Uint8Array,
  inputHash: Uint8Array,
  outputHash: Uint8Array,
): Uint8Array {
  const msg = concatBytes(new Uint8Array([VERSION]), modelHash, inputHash, outputHash);
  return hmac(sha256, salt, msg);
}

/** Accept a hex string OR raw bytes as a 32-byte hash. */
function asHash32(h: string | Uint8Array, label: string): Uint8Array {
  const bytes = typeof h === 'string' ? hexToBytes(h.replace(/^0x/, '')) : h;
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes (got ${bytes.length})`);
  return bytes;
}

/**
 * Generate a TOPLOC commitment over (model, input, output).
 * `modelHash` is a hex string (sha256 of the served model id/weights digest).
 */
export async function generateToploc(
  modelHash: string,
  inputBytes: Uint8Array,
  outputBytes: Uint8Array,
): Promise<ToplockProof> {
  const model = asHash32(modelHash, 'modelHash');
  const input = sha256(inputBytes);
  const output = sha256(outputBytes);
  return buildCommitment(model, input, output);
}

/**
 * Build a TOPLOC commitment from already-computed 32-byte hashes (hex or bytes).
 * Used by the worker, which has hashed the prompt/response inputs already and
 * must not re-hash. Synchronous — no I/O.
 */
export function commitToploc(
  modelHash: string | Uint8Array,
  inputHash: string | Uint8Array,
  outputHash: string | Uint8Array,
): ToplockProof {
  return buildCommitment(
    asHash32(modelHash, 'modelHash'),
    asHash32(inputHash, 'inputHash'),
    asHash32(outputHash, 'outputHash'),
  );
}

function buildCommitment(model: Uint8Array, input: Uint8Array, output: Uint8Array): ToplockProof {
  const salt = randomBytes(32);
  const binding = bindingTag(salt, model, input, output);

  const commitment = new Uint8Array(TOPLOC_SIZE); // fingerprint region stays zeroed
  commitment[OFF.version] = VERSION;
  commitment.set(model, OFF.modelHash);
  commitment.set(input, OFF.inputHash);
  commitment.set(output, OFF.outputHash);
  commitment.set(salt, OFF.salt);
  commitment.set(binding, OFF.binding);

  return {
    commitment,
    model_hash: bytesToHex(model),
    input_hash: bytesToHex(input),
    output_hash: bytesToHex(output),
  };
}

/**
 * Verify a TOPLOC commitment's internal consistency:
 *  - correct size + version
 *  - the binding tag recomputes from the committed fields (tamper-evident)
 *  - the struct's hashes equal the proof's claimed hex hashes
 * Returns false (never throws) so callers can fail closed on `false`.
 */
export async function verifyToploc(proof: ToplockProof): Promise<boolean> {
  try {
    const c = proof.commitment;
    if (c.length !== TOPLOC_SIZE || c[OFF.version] !== VERSION) return false;

    const model = c.subarray(OFF.modelHash, OFF.inputHash);
    const input = c.subarray(OFF.inputHash, OFF.outputHash);
    const output = c.subarray(OFF.outputHash, OFF.salt);
    const salt = c.subarray(OFF.salt, OFF.binding);
    const binding = c.subarray(OFF.binding, OFF.fingerprint);

    const expected = bindingTag(salt, model, input, output);
    if (!constantTimeEqual(binding, expected)) return false;

    return (
      bytesToHex(model) === proof.model_hash.replace(/^0x/, '') &&
      bytesToHex(input) === proof.input_hash.replace(/^0x/, '') &&
      bytesToHex(output) === proof.output_hash.replace(/^0x/, '')
    );
  } catch {
    return false;
  }
}

/**
 * Verify a commitment AND that it binds a specific expected output (recomputed
 * independently by the verifier). This is what the Attestation Verifier / receipt
 * check calls when it has the cleartext output to confirm.
 */
export async function verifyToplocAgainstOutput(
  proof: ToplockProof,
  expectedOutput: Uint8Array,
): Promise<boolean> {
  if (!(await verifyToploc(proof))) return false;
  return bytesToHex(sha256(expectedOutput)) === proof.output_hash.replace(/^0x/, '');
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Transport helpers (worker sends the commitment as a hex string) ──────────

export function toplocToHex(proof: ToplockProof): string {
  return bytesToHex(proof.commitment);
}

/** Reconstruct a proof from the on-wire commitment hex (hashes read from struct). */
export function toplocFromHex(hex: string): ToplockProof {
  const commitment = hexToBytes(hex.replace(/^0x/, ''));
  if (commitment.length !== TOPLOC_SIZE) throw new Error('toplocFromHex: wrong length');
  return {
    commitment,
    model_hash: bytesToHex(commitment.subarray(OFF.modelHash, OFF.inputHash)),
    input_hash: bytesToHex(commitment.subarray(OFF.inputHash, OFF.outputHash)),
    output_hash: bytesToHex(commitment.subarray(OFF.outputHash, OFF.salt)),
  };
}
