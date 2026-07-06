/**
 * Apply x402_settlements migration to Supabase (003).
 * Usage: pnpm migrate:x402
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '../supabase/migrations/003_x402_settlements.sql');

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL required');

  execSync(`psql "${url}" -f "${sqlPath}"`, { stdio: 'inherit' });
  console.log('✅ Applied 003_x402_settlements.sql');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
