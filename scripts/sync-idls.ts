/**
 * Sync Anchor IDL JSON files from target/idl → packages/solana/src/idl
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './solana-lib.js';

const src = join(REPO_ROOT, 'target', 'idl');
const dest = join(REPO_ROOT, 'packages', 'solana', 'src', 'idl');

if (!existsSync(src)) {
  console.error('Run `anchor build` first — target/idl not found');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const name of [
  'worker_registry',
  'job_router',
  'dark_pool',
  'ghst_staking',
  'fee_collector',
  'attestation',
  'governance',
]) {
  cpSync(join(src, `${name}.json`), join(dest, `${name}.json`));
  console.log(`  synced ${name}.json`);
}
console.log('✓ IDLs synced to packages/solana/src/idl');
