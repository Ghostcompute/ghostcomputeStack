/** Browser polyfills before Solana libs load. */
import { Buffer } from 'buffer';

const g = globalThis as typeof globalThis & {
  Buffer: typeof Buffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string | undefined> };
};

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = g;
if (!g.process) g.process = { env: {} };

export * from './dashboard-x402-browser.js';
