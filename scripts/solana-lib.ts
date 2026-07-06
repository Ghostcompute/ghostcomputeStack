/**
 * Shared Solana helpers for devnet scripts (deploy, pump launch, etc.)
 */
import { Keypair } from '@solana/web3.js';
import { loadDevWallet as loadWallet } from '@ghost-compute/solana';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, '..');
export const DEV_WALLET_PATH = join(REPO_ROOT, '.keys', 'dev-wallet.json');

export { loadWallet as loadDevWallet };

/** Write keypair JSON for Anchor CLI (`Anchor.toml` wallet path). */
export function syncDevWalletFile(): Keypair {
  const wallet = loadWallet();
  mkdirSync(dirname(DEV_WALLET_PATH), { recursive: true });
  writeFileSync(DEV_WALLET_PATH, JSON.stringify(Array.from(wallet.secretKey)));
  return wallet;
}

export function getRpcUrl(): string {
  return process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
}

/** Patch .env with key=value lines (creates keys if missing). */
export function patchEnvFile(updates: Record<string, string>, envPath = join(REPO_ROOT, '.env')) {
  if (!existsSync(envPath)) throw new Error(`.env not found at ${envPath}`);
  let content = readFileSync(envPath, 'utf8');
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  writeFileSync(envPath, content);
}
