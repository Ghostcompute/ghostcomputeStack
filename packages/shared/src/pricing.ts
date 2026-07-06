/** pump.fun mints use 6 decimals (platform-fixed). Override via GHST_DECIMALS if needed. */
export function ghstDecimals(): number {
  const raw = process.env.GHST_DECIMALS;
  if (raw == null || raw === '') return 6;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 9) return 6;
  return Math.floor(n);
}

const DEFAULT_GHST_PER_OUTPUT_TOKEN = 1;

/** Whole GHST charged per LLM output token. Env: GHOST_GHST_PER_OUTPUT_TOKEN (default 1). */
export function ghstPerOutputToken(): number {
  const raw = process.env.GHOST_GHST_PER_OUTPUT_TOKEN;
  if (raw == null || raw === '') return DEFAULT_GHST_PER_OUTPUT_TOKEN;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_GHST_PER_OUTPUT_TOKEN;
  return n;
}

/** On-chain GHST base units per output token. */
export function ghstRawPerOutputToken(): bigint {
  return BigInt(Math.round(ghstPerOutputToken() * 10 ** ghstDecimals()));
}

/** Worker UI rate: GHST per 1M output tokens. */
export function ghstPer1MOutputTokens(): number {
  return ghstPerOutputToken() * 1_000_000;
}

export function estimatePaymentRaw(maxOutputTokens: number): bigint {
  return BigInt(maxOutputTokens) * ghstRawPerOutputToken();
}

export function earningsRaw(tokensGenerated: number): bigint {
  return BigInt(tokensGenerated) * ghstRawPerOutputToken();
}

export function rawToGhst(amountRaw: bigint): number {
  return Number(amountRaw) / 10 ** ghstDecimals();
}
