// Phase 0 — Sign-In With Solana → Supabase JWT.
// Wallet proves control of its pubkey by signing a domain-bound, nonce'd
// message; the server verifies the ed25519 signature and mints a Supabase-
// compatible HS256 JWT (role: authenticated) so the rest of the app authorizes
// the wallet via Supabase RLS.

import { createHmac, randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519';
import { PublicKey } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? '');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? '';
const JWT_TTL_SEC = Number(process.env.SIWS_JWT_TTL_SECONDS ?? 3600);
const DOMAIN = process.env.SIWS_DOMAIN ?? 'ghostcompute.tech';

export interface SiwsParams {
  domain: string;
  address: string; // base58 wallet pubkey
  nonce: string;
  issuedAt: string; // ISO
  statement?: string;
}

/** Canonical SIWS message — exactly what the wallet signs and we re-derive. */
export function buildSiwsMessage(p: SiwsParams): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    '',
    p.statement ?? 'Sign in to Ghost Compute.',
    '',
    `URI: https://${p.domain}`,
    `Version: 1`,
    `Nonce: ${p.nonce}`,
    `Issued At: ${p.issuedAt}`,
  ].join('\n');
}

/** Issue + persist a single-use nonce for a sign-in attempt. */
export async function issueNonce(): Promise<string> {
  const nonce = randomBytes(16).toString('hex');
  await db.from('auth_nonces').insert({ nonce });
  return nonce;
}

async function consumeNonce(nonce: string): Promise<boolean> {
  const { data } = await db.from('auth_nonces')
    .select('nonce, consumed, expires_at').eq('nonce', nonce).single();
  if (!data || data.consumed) return false;
  if (new Date(data.expires_at).getTime() < Date.now()) return false;
  await db.from('auth_nonces').update({ consumed: true }).eq('nonce', nonce);
  return true;
}

/** Verify an ed25519 SIWS signature over the canonical message. */
export function verifySiwsSignature(message: string, signatureB64: string, address: string): boolean {
  try {
    const pub = new PublicKey(address).toBytes();
    const sig = Buffer.from(signatureB64, 'base64');
    return ed25519.verify(sig, new TextEncoder().encode(message), pub);
  } catch {
    return false;
  }
}

// ── Supabase-compatible HS256 JWT ────────────────────────────────────────────

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function issueSupabaseJwt(address: string): string {
  if (!JWT_SECRET) throw new Error('SUPABASE_JWT_SECRET not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub: address,
    role: 'authenticated',
    aud: 'authenticated',
    wallet: address,
    iat: now,
    exp: now + JWT_TTL_SEC,
  }));
  const sig = b64url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export interface SiwsAuthInput {
  address: string;
  signature: string; // base64
  nonce: string;
  issuedAt: string;
  statement?: string;
  domain?: string;
}

/**
 * Full SIWS flow: re-derive the message, verify signature, consume the nonce,
 * mint the JWT. Throws on any failure (fail closed — no token issued).
 */
export async function authenticateSiws(input: SiwsAuthInput): Promise<{ token: string; address: string }> {
  const domain = input.domain ?? DOMAIN;
  const message = buildSiwsMessage({
    domain, address: input.address, nonce: input.nonce,
    issuedAt: input.issuedAt, statement: input.statement,
  });

  if (!verifySiwsSignature(message, input.signature, input.address)) {
    throw new Error('SIWS: invalid signature');
  }
  if (!(await consumeNonce(input.nonce))) {
    throw new Error('SIWS: invalid or expired nonce');
  }
  return { token: issueSupabaseJwt(input.address), address: input.address };
}
