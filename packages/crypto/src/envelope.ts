// P1 — Privacy Envelope Orchestrator
// Given a job's guarantee level, returns the ordered layer composition that
// must wrap the job (spec Part III, 3.x). Consumed by both the inference path
// (P3/L2) and the dark-pool path (L3), so the layer set is the single source
// of truth for "what privacy machinery this job is entitled to / requires".

import { Guarantee } from '@ghost-compute/shared';

/** The privacy layers that can compose an envelope, in canonical order. */
export enum EnvelopeLayer {
  /** Trusted Execution Environment — plaintext only ever exists in-enclave. */
  TEE = 'TEE',
  /** Hardware attestation of the enclave (NVIDIA CC / AMD SEV-SNP). */
  Attest = 'Attest',
  /** TOPLOC output commitment (fast, 258-byte). */
  TOPLOC = 'TOPLOC',
  /** Zero-knowledge proof of correct execution (groth16/bn254). */
  ZK = 'ZK',
  /** Multi-party computation trust-split (Arcium). */
  MPC = 'MPC',
  /** Fully-homomorphic encryption on flagged sub-operations. */
  FHE = 'FHE',
  /** Confidential settlement (Token-2022 Confidential Balances). */
  ConfidentialSettle = 'ConfidentialSettle',
}

export interface EnvelopeSpec {
  guarantee: Guarantee;
  /** Ordered layers to apply, outermost trust boundary first. */
  layers: EnvelopeLayer[];
  /** Which output proof system this tier uses. */
  proofSystem: 'toploc' | 'zk';
  /** Attestation is mandatory for every confidential tier. */
  requiresAttestation: boolean;
  /** MaxTrustSplit splits the computation across MPC nodes. */
  requiresMpc: boolean;
  /** FHE is applied to operations explicitly flagged as sensitive. */
  fheOnFlaggedOps: boolean;
}

export interface ComposeOptions {
  /**
   * For MaxTrustSplit: whether this job carries operations flagged for FHE
   * (e.g. dark-pool price comparison). When true, FHE is added to the layers.
   */
  flaggedFheOps?: boolean;
}

/**
 * Compose the privacy envelope for a job.
 *
 * Standard      → [TEE, Attest, TOPLOC, ConfidentialSettle]
 * High          → [TEE, Attest, ZK, ConfidentialSettle]
 * MaxTrustSplit → [TEE, Attest, ZK, MPC, ConfidentialSettle]  (+FHE on flagged ops)
 */
export function composeEnvelope(
  guarantee: Guarantee,
  opts: ComposeOptions = {},
): EnvelopeSpec {
  switch (guarantee) {
    case Guarantee.Standard:
      return {
        guarantee,
        layers: [
          EnvelopeLayer.TEE,
          EnvelopeLayer.Attest,
          EnvelopeLayer.TOPLOC,
          EnvelopeLayer.ConfidentialSettle,
        ],
        proofSystem: 'toploc',
        requiresAttestation: true,
        requiresMpc: false,
        fheOnFlaggedOps: false,
      };

    case Guarantee.High:
      return {
        guarantee,
        layers: [
          EnvelopeLayer.TEE,
          EnvelopeLayer.Attest,
          EnvelopeLayer.ZK,
          EnvelopeLayer.ConfidentialSettle,
        ],
        proofSystem: 'zk',
        requiresAttestation: true,
        requiresMpc: false,
        fheOnFlaggedOps: false,
      };

    case Guarantee.MaxTrustSplit: {
      const flaggedFheOps = opts.flaggedFheOps ?? false;
      const layers = [
        EnvelopeLayer.TEE,
        EnvelopeLayer.Attest,
        EnvelopeLayer.ZK,
        EnvelopeLayer.MPC,
        EnvelopeLayer.ConfidentialSettle,
      ];
      // FHE sits between MPC and settlement when sensitive ops are flagged.
      if (flaggedFheOps) {
        layers.splice(layers.indexOf(EnvelopeLayer.MPC) + 1, 0, EnvelopeLayer.FHE);
      }
      return {
        guarantee,
        layers,
        proofSystem: 'zk',
        requiresAttestation: true,
        requiresMpc: true,
        fheOnFlaggedOps: flaggedFheOps,
      };
    }

    default: {
      // Exhaustiveness guard — fail closed on an unknown guarantee.
      const _never: never = guarantee;
      throw new Error(`composeEnvelope: unknown guarantee ${String(_never)}`);
    }
  }
}

/** Does this envelope require a confidential-only worker (attested TEE)? */
export function requiresConfidentialWorker(spec: EnvelopeSpec): boolean {
  return spec.layers.includes(EnvelopeLayer.TEE) && spec.requiresAttestation;
}
