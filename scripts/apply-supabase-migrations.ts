/**
 * Apply supabase/migrations/*.sql to a remote Postgres database.
 *
 * Requires SUPABASE_DB_URL (or DATABASE_URL) in .env:
 *   Dashboard → Settings → Database → Connection string → URI
 *
 * Usage: pnpm apply:supabase-migrations
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import './load-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', 'supabase', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function getDbUrl(): string {
  return (
    process.env.SUPABASE_DB_URL?.trim()
    ?? process.env.DATABASE_URL?.trim()
    ?? ''
  );
}

async function main() {
  const url = getDbUrl();
  if (!url) {
    const files = migrationFiles();
    console.error(`
SUPABASE_DB_URL (or DATABASE_URL) is not set.

Copy the Postgres connection URI from Supabase Dashboard:
  Settings → Database → Connection string → URI
  (use the database password you set when creating the project)

Add to .env:
  SUPABASE_DB_URL=postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres

Then run:
  pnpm apply:supabase-migrations

Or paste each file manually in Dashboard → SQL Editor:
`);
    for (const f of files) console.error(`  supabase/migrations/${f}`);
    process.exit(1);
  }

  const files = migrationFiles();
  if (!files.length) {
    console.error('No migration files found in supabase/migrations/');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log('\nApplying Supabase migrations…\n');

  for (const file of files) {
    const path = join(MIGRATIONS_DIR, file);
    const sql = readFileSync(path, 'utf8');
    process.stdout.write(`  → ${file} … `);
    try {
      await client.query(sql);
      console.log('ok');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('already exists')) {
        console.log('skipped (already applied)');
      } else {
        console.log('FAILED');
        console.error(msg);
        await client.end();
        process.exit(1);
      }
    }
  }

  await client.end();
  console.log('\nDone. Migrations applied.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
