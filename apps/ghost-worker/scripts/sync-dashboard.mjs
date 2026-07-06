#!/usr/bin/env node
/** Copy dashboard static assets from monorepo public/ into ghost-worker/ */
import { cp, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const DEST = join(APP, 'dashboard');
const PUB = join(APP, 'public');
const MONO = join(APP, '..', '..', 'public');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDashboard() {
  if (!(await exists(join(MONO, 'dashboard.html')))) {
    console.log('[sync-dashboard] monorepo public/ not found — using vendored files');
    return;
  }
  await mkdir(DEST, { recursive: true });
  await mkdir(join(PUB, 'wallets'), { recursive: true });
  await cp(join(MONO, 'dashboard.html'), join(APP, 'index.html'));
  for (const f of [
    'dashboard-auth.mjs',
    'dashboard-fleet.mjs',
    'dashboard-attestation.mjs',
    'dashboard-darkpool.mjs',
    'dashboard-points.mjs',
    'dashboard-x402.bundle.mjs',
  ]) {
    await cp(join(MONO, f), join(DEST, f));
  }
  await cp(join(MONO, 'wallets/phantom.jpg'), join(PUB, 'wallets/phantom.jpg'));
  await cp(join(MONO, 'wallets/solflare.png'), join(PUB, 'wallets/solflare.png'));
  if (await exists(join(MONO, 'ghost-logo.png'))) {
    await cp(join(MONO, 'ghost-logo.png'), join(PUB, 'ghost-logo.png'));
  }
  console.log('[sync-dashboard] copied dashboard → ghost-worker');
}

await copyDashboard();
await import('./patch-dashboard.mjs');
