import { PublicKey } from "@solana/web3.js";

const STORAGE_KEY = "ghost.operatorAddress";

/** Known sentinel pubkeys — never valid operator payout addresses. */
const PLACEHOLDER_ADDRESSES = new Set([
  "11111111111111111111111111111111",
  "11111111111111111111111111111112",
  "So11111111111111111111111111111111111111112",
]);

export function isPlaceholderOperatorAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (PLACEHOLDER_ADDRESSES.has(trimmed)) return true;
  if (/^1{20,}$/.test(trimmed)) return true;
  return false;
}

export function isValidSolanaAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || isPlaceholderOperatorAddress(trimmed)) return false;
  try {
    const pk = new PublicKey(trimmed);
    return PublicKey.isOnCurve(pk.toBytes());
  } catch {
    return false;
  }
}

/** Valid operator payout address (real wallet, not a system placeholder). */
export function isValidOperatorAddress(value: string): boolean {
  return isValidSolanaAddress(value);
}

export function resolveOperatorAddress(
  ...sources: Array<string | null | undefined>
): string | null {
  for (const source of sources) {
    const trimmed = source?.trim();
    if (trimmed && isValidOperatorAddress(trimmed)) return trimmed;
  }
  return null;
}

export function getStoredOperatorAddress(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)?.trim();
    if (!raw || !isValidOperatorAddress(raw)) {
      if (raw) localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function storeOperatorAddress(address: string): void {
  const trimmed = address.trim();
  if (!isValidOperatorAddress(trimmed)) {
    throw new Error("Invalid operator address");
  }
  localStorage.setItem(STORAGE_KEY, trimmed);
}

export function clearStoredOperatorAddress(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function truncateAddress(address: string, lead = 4, trail = 4): string {
  if (address.length <= lead + trail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-trail)}`;
}

/** Two-char avatar label derived from a base58 address. */
export function addressAvatarLabel(address: string, fallback = "GW"): string {
  const clean = address.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "");
  if (clean.length >= 2) return clean.slice(0, 2).toUpperCase();
  return fallback;
}
