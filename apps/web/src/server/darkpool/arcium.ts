// P5 — Arcium MPC trust-split client.
// Confidential cross-order matching for MaxTrustSplit: the comparison the FHE
// layer can't do alone (price-cross / fill sizing over encrypted operands) is
// split across Arcium MPC nodes so no single party sees the cleartext.
//
// This is a REAL interface with a documented devnet stub: when ARCIUM_API_KEY
// is configured it calls the Arcium MXE; otherwise it runs the same computation
// in-enclave-equivalent locally and clearly flags the result as `stubbed` so
// production is a config swap, not a rewrite (per plan Key Risks).

const ARCIUM_API_KEY = process.env.ARCIUM_API_KEY ?? '';
const ARCIUM_URL = process.env.ARCIUM_URL ?? 'https://api.arcium.network/v1';
const ARCIUM_CLUSTER = process.env.ARCIUM_CLUSTER ?? 'devnet';

export interface EncryptedOperand {
  /** Serialized FHE ciphertext (see packages/crypto fhe.ts) or sealed blob. */
  ciphertext: string;
  owner_pubkey: string;
}

export interface MpcMatchInput {
  buy: EncryptedOperand;
  sell: EncryptedOperand;
  /** Public market context the MPC may use (base/quote), never the amounts. */
  base_mint: string;
  quote_mint: string;
}

export interface MpcMatchResult {
  crossed: boolean;
  /** Cleared fill — only this is revealed; resting book stays sealed. */
  fill_amount_raw: string;
  fill_price_raw: string;
  /** True when produced by a real Arcium MXE; false when locally stubbed. */
  mpc: boolean;
  arcium_job_id?: string;
}

export function arciumEnabled(): boolean {
  return ARCIUM_API_KEY.length > 0;
}

/**
 * Submit a confidential match to Arcium and await the cleared fill.
 * `localClear` is the in-enclave fallback used when Arcium is unavailable; it
 * receives the already-decrypted operands the caller holds inside its TEE.
 */
export async function mpcMatch(
  input: MpcMatchInput,
  localClear: () => Promise<Omit<MpcMatchResult, 'mpc' | 'arcium_job_id'>>,
): Promise<MpcMatchResult> {
  if (!arciumEnabled()) {
    const r = await localClear();
    return { ...r, mpc: false };
  }

  const res = await fetch(`${ARCIUM_URL}/mxe/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ARCIUM_API_KEY}` },
    body: JSON.stringify({
      cluster: ARCIUM_CLUSTER,
      computation: 'dark_pool_cross_v1',
      inputs: {
        buy: input.buy.ciphertext,
        sell: input.sell.ciphertext,
        base_mint: input.base_mint,
        quote_mint: input.quote_mint,
      },
    }),
  });
  if (!res.ok) throw new Error(`Arcium MXE error ${res.status}: ${await res.text().catch(() => '')}`);

  const out = (await res.json()) as {
    job_id: string;
    crossed: boolean;
    fill_amount: string;
    fill_price: string;
  };
  return {
    crossed: out.crossed,
    fill_amount_raw: out.fill_amount,
    fill_price_raw: out.fill_price,
    mpc: true,
    arcium_job_id: out.job_id,
  };
}
