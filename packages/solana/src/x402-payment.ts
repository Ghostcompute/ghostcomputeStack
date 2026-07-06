import type { X402Receipt } from './x402.js';
import { parseX402Header } from './x402.js';

/** x402 payment envelope — receipt + optional client-signed settlement tx. */
export interface X402Payment {
  receipt: X402Receipt;
  /** Base64 serialized signed Transaction (legacy) or VersionedTransaction. */
  settlement_tx?: string;
}

export function isX402Payment(value: unknown): value is X402Payment {
  return (
    typeof value === 'object'
    && value !== null
    && 'receipt' in value
    && typeof (value as X402Payment).receipt === 'object'
  );
}

export function encodeX402Payment(payment: X402Payment): string {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

export function parseX402Payment(header: string | null | undefined): X402Payment | null {
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as unknown;
    if (isX402Payment(parsed)) return parsed;
    const legacy = parsed as X402Receipt;
    if (legacy?.payer && legacy?.signature) {
      return { receipt: legacy };
    }
    return null;
  } catch {
    return parseX402Header(header) ? { receipt: parseX402Header(header)! } : null;
  }
}

export function receiptFromPaymentHeader(header: string | null | undefined): X402Receipt | null {
  return parseX402Payment(header)?.receipt ?? parseX402Header(header ?? null);
}
