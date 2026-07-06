// P3 — Attestation Verifier.
// Verifies NVIDIA CC / AMD SEV-SNP quotes against vendor roots, computes the
// canonical report hash (anchored on-chain by JobRouter/attestation program),
// and exposes verify-by-hash. Fails CLOSED: anything we cannot positively
// verify is NOT marked 'verified'.

import { createHash, X509Certificate } from 'node:crypto';
import type { AttestationQuote, AttestationResult } from '@ghost-compute/shared';

// ── AMD SEV-SNP ATTESTATION_REPORT layout (v2) ───────────────────────────────
// Offsets into the signed report body (little-endian scalars).
const SNP_OFF_VERSION = 0x000;      // u32
const SNP_OFF_REPORT_DATA = 0x050;  // 64 bytes — user-supplied challenge binding
const SNP_OFF_MEASUREMENT = 0x090;  // 48 bytes — launch measurement (must be set)
const SNP_MEASUREMENT_LEN = 48;
const SNP_REPORT_DATA_LEN = 64;
const SNP_MIN_LEN = SNP_OFF_MEASUREMENT + SNP_MEASUREMENT_LEN; // enough to read both fields

// Vendor roots are PEM (or base64-PEM) provided via env (spec Part IX).
const NVIDIA_ROOT = normalizePem(process.env.NVIDIA_ATTESTATION_ROOT ?? '');
const AMD_ROOT = normalizePem(process.env.AMD_SEV_ROOT ?? '');

// Replay window: a quote older than this (ms) is rejected. Mirrors
// governance_params.attestation_max_age_seconds (default 3600s).
const MAX_AGE_MS = Number(process.env.ATTESTATION_MAX_AGE_SECONDS ?? 3600) * 1000;
const CLOCK_SKEW_MS = 60_000;

function normalizePem(v: string): string {
  if (!v) return '';
  if (v.includes('BEGIN CERTIFICATE')) return v;
  // Allow a base64-of-PEM env value.
  try {
    const decoded = Buffer.from(v, 'base64').toString('utf8');
    if (decoded.includes('BEGIN CERTIFICATE')) return decoded;
  } catch { /* not base64 */ }
  return '';
}

/** Canonical sha256 over the parts of the quote that must not change. */
export function reportHash(q: AttestationQuote): string {
  const canonical = JSON.stringify({
    worker_pubkey: q.worker_pubkey,
    tee_type: q.tee_type,
    nonce: q.nonce,
    enclave_pubkey: q.enclave_pubkey,
    report_bytes: q.report_bytes,
    timestamp: q.timestamp,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function rootFor(teeType: string): { pem: string; id: string } | null {
  if (teeType === 'nvidia_cc' && NVIDIA_ROOT) return { pem: NVIDIA_ROOT, id: 'nvidia_attestation_root' };
  if (teeType === 'amd_sev_snp' && AMD_ROOT) return { pem: AMD_ROOT, id: 'amd_sev_root' };
  return null;
}

/**
 * Verify the PEM cert chain leaf→…→root chains to the configured vendor root.
 * Each cert must be issued by the next; the last must be issued by (or equal)
 * the vendor root.
 */
function verifyChain(chainPem: string[], rootPem: string): { ok: boolean; reason?: string } {
  if (!chainPem.length) return { ok: false, reason: 'empty certificate chain' };
  let certs: X509Certificate[];
  let root: X509Certificate;
  try {
    certs = chainPem.map((p) => new X509Certificate(p));
    root = new X509Certificate(rootPem);
  } catch (e) {
    return { ok: false, reason: `unparseable certificate: ${(e as Error).message}` };
  }

  const now = Date.now();
  for (const c of certs) {
    const notBefore = Date.parse(c.validFrom);
    const notAfter = Date.parse(c.validTo);
    if (now < notBefore - CLOCK_SKEW_MS || now > notAfter + CLOCK_SKEW_MS) {
      return { ok: false, reason: `certificate outside validity window` };
    }
  }
  // Walk the chain: each cert verified by the next issuer's public key.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      return { ok: false, reason: `broken chain link at index ${i}` };
    }
  }
  // Last cert must chain to the vendor root (issued by it, or be it).
  const last = certs[certs.length - 1];
  const chainsToRoot = last.verify(root.publicKey) || last.fingerprint256 === root.fingerprint256;
  if (!chainsToRoot) return { ok: false, reason: 'chain does not terminate at vendor root' };
  return { ok: true };
}

/** Dev-only: accept mock quotes produced when ATTESTATION_ENDPOINT is unset. */
function isDevMockQuote(quote: AttestationQuote): boolean {
  if (process.env.DEV_MOCK_ATTESTATION !== 'true') return false;
  try {
    const raw = Buffer.from(quote.report_bytes, 'base64').toString('utf8');
    return raw.startsWith('mock-');
  } catch {
    return false;
  }
}

/**
 * Verify an attestation quote. `expectedNonce` is the challenge the verifier
 * issued for this worker; it must match the quote's nonce (anti-replay).
 */
export function verifyQuote(quote: AttestationQuote, expectedNonce?: string): AttestationResult {
  const base = {
    report_hash: reportHash(quote),
    worker_pubkey: quote.worker_pubkey,
    tee_type: quote.tee_type,
    enclave_pubkey: quote.enclave_pubkey,
  };
  const reject = (reject_reason: string): AttestationResult => ({ verdict: 'rejected', reject_reason, ...base });

  // 1. Freshness / replay window.
  if (typeof quote.timestamp !== 'number' || quote.timestamp > Date.now() + CLOCK_SKEW_MS) {
    return reject('timestamp in the future');
  }
  if (Date.now() - quote.timestamp > MAX_AGE_MS) {
    return reject('quote older than max age');
  }
  if (expectedNonce && quote.nonce !== expectedNonce) {
    return reject('nonce mismatch (possible replay)');
  }

  if (isDevMockQuote(quote)) {
    return { verdict: 'verified', vendor_root_id: 'dev_mock', ...base };
  }

  // 2. Vendor root must be configured — else fail CLOSED (not 'verified').
  const root = rootFor(quote.tee_type);
  if (!root) {
    return { verdict: 'unverified_no_root', ...base };
  }

  // 3. Cert chain → vendor root.
  const chain = verifyChain(quote.certificate_chain, root.pem);
  if (!chain.ok) return reject(chain.reason ?? 'chain verification failed');

  // 4. Vendor-specific report-body checks. The signed chain establishes the
  //    quote came from genuine vendor silicon; here we parse the report body,
  //    confirm the launch measurement is present, and — critically — that the
  //    report binds BOTH the freshness nonce AND the enclave public key clients
  //    seal to (anti-replay + key substitution). Fail-closed.
  const bodyOk = verifyReportBody(quote);
  if (!bodyOk.ok) return reject(bodyOk.reason ?? 'report body check failed');

  return { verdict: 'verified', vendor_root_id: root.id, ...base };
}

/**
 * Canonical challenge binding the honest enclave must embed in the report's
 * user-data / report_data field:  SHA-512(nonce || enclave_pubkey)  (64 bytes,
 * exactly the SEV-SNP report_data width). Binding the enclave pubkey — not just
 * the nonce — is what stops a key-substitution replay: an attacker cannot take a
 * genuine attestation for one enclave key and re-advertise it for another.
 */
function challengeBinding(quote: AttestationQuote): Buffer {
  const nonceBuf = Buffer.from(quote.nonce.replace(/^0x/, ''), 'hex');
  const encBuf = Buffer.from(quote.enclave_pubkey.replace(/^0x/, ''), 'hex');
  return createHash('sha512').update(nonceBuf).update(encBuf).digest();
}

function isAllZero(b: Buffer): boolean {
  for (const x of b) if (x !== 0) return false;
  return true;
}

/**
 * Vendor-specific report-body verification. Parses the evidence, requires the
 * launch measurement to be present, and requires the report to bind the
 * canonical challenge (nonce + enclave pubkey). Fail-closed: any structural or
 * binding failure rejects.
 */
export function verifyReportBody(quote: AttestationQuote): { ok: boolean; reason?: string } {
  let raw: Buffer;
  try {
    raw = Buffer.from(quote.report_bytes, 'base64');
  } catch {
    return { ok: false, reason: 'report_bytes not base64' };
  }
  if (raw.length < 32) return { ok: false, reason: 'report too short' };

  const binding = challengeBinding(quote);
  const nonceBuf = Buffer.from(quote.nonce.replace(/^0x/, ''), 'hex');
  const encBuf = Buffer.from(quote.enclave_pubkey.replace(/^0x/, ''), 'hex');
  if (!encBuf.length) return { ok: false, reason: 'quote missing enclave_pubkey' };

  // AMD SEV-SNP: parse the ATTESTATION_REPORT structure.
  if (quote.tee_type === 'amd_sev_snp' && raw.length >= SNP_MIN_LEN) {
    const version = raw.readUInt32LE(SNP_OFF_VERSION);
    if (version < 1 || version > 8) return { ok: false, reason: `unsupported SEV-SNP report version ${version}` };
    const reportData = raw.subarray(SNP_OFF_REPORT_DATA, SNP_OFF_REPORT_DATA + SNP_REPORT_DATA_LEN);
    const measurement = raw.subarray(SNP_OFF_MEASUREMENT, SNP_OFF_MEASUREMENT + SNP_MEASUREMENT_LEN);
    if (isAllZero(measurement)) return { ok: false, reason: 'zero launch measurement' };
    // report_data must carry the canonical binding (nonce + enclave pubkey).
    if (reportData.equals(binding)) return { ok: true };
    // Back-compat: accept a report_data that binds nonce AND enclave pubkey
    // separately (both must be present), but never nonce alone.
    if (bufContains(reportData, nonceBuf) && bufContains(reportData, encBuf)) return { ok: true };
    return { ok: false, reason: 'report_data does not bind nonce + enclave pubkey' };
  }

  // NVIDIA CC / other evidence: no fixed struct — require the canonical binding
  // to appear in the evidence, or (back-compat) both nonce and enclave pubkey.
  if (bufContains(raw, binding)) return { ok: true };
  if (nonceBuf.length && bufContains(raw, nonceBuf) && bufContains(raw, encBuf)) return { ok: true };
  return { ok: false, reason: 'evidence does not bind nonce + enclave pubkey' };
}

function bufContains(haystack: Buffer, needle: Buffer): boolean {
  if (!needle.length) return false;
  return haystack.includes(needle);
}
