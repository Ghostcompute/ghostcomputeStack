// Phase 0 — Sign-In With Solana React hook.
// Connects an injected wallet (Phantom / Solflare), requests a nonce, signs the
// canonical SIWS message, exchanges it for a Supabase JWT, and persists it.

import { useCallback, useEffect, useState } from 'react';
import { apiUrl } from '../lib/api.js';

interface InjectedWallet {
  publicKey?: { toBase58(): string };
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  signMessage(msg: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array }>;
}

function getProvider(prefer?: 'phantom' | 'solflare'): InjectedWallet | null {
  const w = window as unknown as {
    phantom?: { solana?: InjectedWallet };
    solflare?: InjectedWallet;
    solana?: InjectedWallet;
  };
  if (prefer === 'solflare') return w.solflare ?? null;
  if (prefer === 'phantom') return w.phantom?.solana ?? null;
  return w.phantom?.solana ?? w.solflare ?? w.solana ?? null;
}

const TOKEN_KEY = 'ghost_siws_jwt';
const ADDR_KEY = 'ghost_siws_addr';

export interface SiwsState {
  address: string | null;
  token: string | null;
  connecting: boolean;
  error: string | null;
}

export function useSiws() {
  const [state, setState] = useState<SiwsState>({ address: null, token: null, connecting: false, error: null });

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    const address = localStorage.getItem(ADDR_KEY);
    if (token && address) setState((s) => ({ ...s, token, address }));
  }, []);

  const signIn = useCallback(async (prefer?: 'phantom' | 'solflare') => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const provider = getProvider(prefer);
      if (!provider) throw new Error('No Solana wallet found (install Phantom or Solflare)');

      const { publicKey } = await provider.connect();
      const address = publicKey.toBase58();

      // 1. nonce
      const nonceRes = await fetch(apiUrl('/api/auth/nonce'), { method: 'POST' });
      const { nonce } = await nonceRes.json();

      // 2. build + sign the canonical message
      const issuedAt = new Date().toISOString();
      const domain = window.location.host;
      const message = [
        `${domain} wants you to sign in with your Solana account:`,
        address, '',
        'Sign in to Ghost Compute.', '',
        `URI: https://${domain}`,
        'Version: 1',
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
      ].join('\n');
      const { signature } = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
      const signatureB64 = btoa(String.fromCharCode(...signature));

      // 3. exchange for JWT
      const authRes = await fetch(apiUrl('/api/auth/siws'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, signature: signatureB64, nonce, issuedAt, domain }),
      });
      if (!authRes.ok) throw new Error((await authRes.json()).error ?? 'sign-in failed');
      const { token } = await authRes.json();

      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(ADDR_KEY, address);
      setState({ address, token, connecting: false, error: null });
      return { address, token };
    } catch (err) {
      setState((s) => ({ ...s, connecting: false, error: (err as Error).message }));
      throw err;
    }
  }, []);

  const signOut = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADDR_KEY);
    setState({ address: null, token: null, connecting: false, error: null });
  }, []);

  return { ...state, signIn, signOut };
}
