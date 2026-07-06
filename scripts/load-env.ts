/**
 * Load .env with override so shell-exported placeholders don't win over repo .env.
 * Import this before any module that reads process.env (programs, x402, etc.).
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

if (existsSync(envPath)) {
  config({ path: envPath, override: true });
}
