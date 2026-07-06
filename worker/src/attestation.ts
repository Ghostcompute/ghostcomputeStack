import { TEE_TYPE, ATTESTATION_ENDPOINT } from './config.js';
import crypto from 'node:crypto';
import { commitToploc, toplocToHex, generateEnclaveKeypair, toHex, type EnclaveKeypair } from '@ghost-compute/crypto';

// The enclave keypair: private half stays in-process (in-enclave); the public
// half is advertised via attestation so clients can seal payloads to it (P2).
let _enclaveKeypair: EnclaveKeypair | null = null;
export function getEnclaveKeypair(): EnclaveKeypair {
  if (!_enclaveKeypair) _enclaveKeypair = generateEnclaveKeypair();
  return _enclaveKeypair;
}
export function getEnclavePubkeyHex(): string {
  return toHex(getEnclaveKeypair().publicKey);
}

export interface AttestationReport {
  tee_type: string;
  report_bytes: string;
  certificate_chain: string[];
  timestamp: number;
}

// Fetch NVIDIA Confidential Computing attestation report
async function fetchNvidiaAttestation(nonce: string): Promise<AttestationReport> {
  if (!ATTESTATION_ENDPOINT) {
    return mockAttestation('nvidia_cc', nonce);
  }
  const res = await fetch(`${ATTESTATION_ENDPOINT}/attest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) throw new Error(`Attestation failed: ${res.status}`);
  return res.json();
}

// AMD SEV-SNP attestation via /dev/sev-guest
async function fetchAmdAttestation(nonce: string): Promise<AttestationReport> {
  if (!ATTESTATION_ENDPOINT) {
    return mockAttestation('amd_sev_snp', nonce);
  }
  const res = await fetch(`${ATTESTATION_ENDPOINT}/sev-snp/attest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
  });
  if (!res.ok) throw new Error(`AMD attestation failed: ${res.status}`);
  return res.json();
}

function mockAttestation(teeType: string, nonce: string): AttestationReport {
  return {
    tee_type: teeType,
    report_bytes: Buffer.from(`mock-${teeType}-${nonce}`).toString('base64'),
    certificate_chain: [],
    timestamp: Date.now(),
  };
}

export async function getAttestation(nonce: string): Promise<AttestationReport | null> {
  try {
    if (TEE_TYPE === 'nvidia_cc') return await fetchNvidiaAttestation(nonce);
    if (TEE_TYPE === 'amd_sev_snp') return await fetchAmdAttestation(nonce);
    return null;
  } catch (err) {
    console.error('[attestation] failed:', err);
    return null;
  }
}

// Produce the canonical 258-byte TOPLOC commitment (P4) over
// (model, input_hash, output_hash). `model` is the model id; we hash it to the
// 32-byte model_hash. Returns the commitment as hex for transport.
export function makeToploc(model: string, inputHash: string, outputHash: string): string {
  const modelHash = crypto.createHash('sha256').update(model).digest('hex');
  return toplocToHex(commitToploc(modelHash, inputHash, outputHash));
}
