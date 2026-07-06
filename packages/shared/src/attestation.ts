// Attestation quote contract (defines, the worker produces — P3).
// The worker calls its enclave to fill this struct; the Vercel Attestation
// Verifier checks it against vendor roots and anchors report_hash on-chain.

import { TeeType } from './types.js';

export interface AttestationQuote {
  /** Worker's Solana pubkey (registration identity). */
  worker_pubkey: string;
  /** Which confidential-compute vendor produced the quote. */
  tee_type: TeeType.NvidiaCC | TeeType.AmdSevSnp;
  /** Freshness challenge the verifier issued (hex); echoed inside report_bytes. */
  nonce: string;
  /** The X25519 enclave public key this attestation vouches for (hex, 32 bytes). */
  enclave_pubkey: string;
  /** Vendor quote/report, base64 (NVIDIA CC evidence or SEV-SNP ATTESTATION_REPORT). */
  report_bytes: string;
  /** PEM certificate chain leaf→root used to verify the report signature. */
  certificate_chain: string[];
  /** Unix ms when the quote was generated (replay window check). */
  timestamp: number;
}

export type AttestationVerdict =
  | 'verified'
  | 'rejected'
  | 'unverified_no_root'; // fail-closed: no vendor root configured to check against

export interface AttestationResult {
  verdict: AttestationVerdict;
  /** sha256 of the canonical quote (hex) — the on-chain anchor + DB key. */
  report_hash: string;
  worker_pubkey: string;
  tee_type: string;
  enclave_pubkey: string;
  /** Set when verdict === 'rejected'. */
  reject_reason?: string;
  /** Identifier of the vendor root that verified the chain. */
  vendor_root_id?: string;
}
