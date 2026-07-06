/** SIWS auth + app config for dashboard.html (Track B production path). */

import { apiUrl } from './dashboard-api.mjs';

const AUTH_STORAGE_KEY = 'ghost.auth';

let appConfig = {
  skipAuth: true,
  skipX402: false,
  devSignEnabled: false,
  siwsDomain: 'localhost',
};

export function getAppConfig() {
  return appConfig;
}

export async function loadAppConfig() {
  try {
    const res = await fetch(apiUrl('/api/x402/config'));
    if (!res.ok) return appConfig;
    const cfg = await res.json();
    appConfig = {
      skipAuth: !!cfg.skipAuth,
      skipX402: !!cfg.skipX402,
      devSignEnabled: !!cfg.devSignEnabled,
      siwsDomain: cfg.siwsDomain || 'localhost',
    };
  } catch (err) {
    console.warn('[auth] config load failed:', err);
  }
  return appConfig;
}

/** Load server auth config and sync dashboard auth UI. */
export async function initDashboardAuth() {
  await loadAppConfig();
  applyAuthUi();
}

export function applyAuthUi() {
  const wrap = document.getElementById('inferDevSignWrap');
  const devSign = document.getElementById('inferDevSign');
  if (wrap) wrap.style.display = appConfig.devSignEnabled ? '' : 'none';
  if (devSign && !appConfig.devSignEnabled) devSign.checked = false;

  const tag = document.getElementById('inferAuthTag');
  if (tag) {
    if (appConfig.skipAuth) {
      tag.textContent = 'dev auth off';
      tag.className = 'tag tag-warn';
    } else if (getAuthToken()) {
      tag.textContent = 'signed in';
      tag.className = 'tag tag-ok';
    } else {
      tag.textContent = 'wallet sign-in';
      tag.className = 'tag';
    }
  }
}

export function getAuthToken() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.exp && Date.now() > parsed.exp) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return parsed.token || null;
  } catch {
    return null;
  }
}

export function clearAuthToken() {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  applyAuthUi();
}

function storeAuthToken(token, ttlSec = 3600) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({
    token,
    exp: Date.now() + ttlSec * 1000,
  }));
  applyAuthUi();
}

function buildSiwsMessage(domain, address, nonce, issuedAt) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    'Sign in to Ghost Compute.',
    '',
    `URI: https://${domain}`,
    'Version: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
}

function sigToBase64(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function siwsLogin(provider, address) {
  const domain = appConfig.siwsDomain;
  const nonceRes = await fetch(apiUrl('/api/auth/nonce'), { method: 'POST' });
  if (!nonceRes.ok) throw new Error('Failed to issue auth nonce');
  const { nonce } = await nonceRes.json();
  const issuedAt = new Date().toISOString();
  const message = buildSiwsMessage(domain, address, nonce, issuedAt);
  const encoded = new TextEncoder().encode(message);

  let signature;
  if (typeof provider.signMessage === 'function') {
    const out = await provider.signMessage(encoded, 'utf8');
    signature = out.signature ?? out;
  } else {
    throw new Error('Wallet does not support signMessage');
  }

  const res = await fetch(apiUrl('/api/auth/siws'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      signature: sigToBase64(signature),
      nonce,
      issuedAt,
      domain,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'SIWS authentication failed');

  storeAuthToken(body.token);
  return body.token;
}

export async function ensureAuthenticated(provider, address) {
  if (appConfig.skipAuth) return null;
  const existing = getAuthToken();
  if (existing) return existing;
  if (!provider || !address) throw new Error('Connect wallet and sign in first');
  return siwsLogin(provider, address);
}

export function authHeaders() {
  const token = getAuthToken();
  if (!token || appConfig.skipAuth) return {};
  return { Authorization: `Bearer ${token}` };
}

export async function ensureSiwsAfterConnect(provider, address) {
  if (appConfig.skipAuth) return null;
  try {
    await ensureAuthenticated(provider, address);
    window.toast?.('Signed in with wallet');
    return getAuthToken();
  } catch (err) {
    window.toast?.('Wallet sign-in: ' + (err.message || err));
    return null;
  }
}
