/**
 * Apply chain_events migration to Supabase (004).
 * Usage: pnpm migrate:chain-events
 *
 * Tries psql against DATABASE_URL; if that fails, checks Supabase REST and
 * prints the SQL for manual run in the dashboard SQL editor.
 */
import './load-env.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sqlPath = join(__dirname, '../supabase/migrations/004_chain_events.sql');

async function tableExists(): Promise<boolean> {
  const db = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE ?? '',
  );
  const { error } = await db.from('chain_events').select('id', { count: 'exact', head: true });
  return !error;
}

async function main() {
  if (await tableExists()) {
    console.log('✅ chain_events already exists — skipping migration');
    return;
  }

  const url = process.env.DATABASE_URL?.trim();
  if (url) {
    try {
      execSync(`psql "${url}" -f "${sqlPath}"`, { stdio: 'inherit' });
      console.log('✅ Applied 004_chain_events.sql via psql');
      return;
    } catch (err) {
      console.warn('psql migration failed:', (err as Error).message);
    }
  }

  if (await tableExists()) {
    console.log('✅ chain_events now exists');
    return;
  }

  console.error('\nCould not apply migration automatically.');
  console.error('Run this SQL in Supabase → SQL Editor:\n');
  console.error(readFileSync(sqlPath, 'utf8'));
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
