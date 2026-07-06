/**
 * Deploy all Anchor programs to devnet.
 * Syncs DEV_WALLET → .keys/dev-wallet.json, builds, syncs program IDs, deploys via solana CLI.
 *
 * Usage: pnpm deploy:programs
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadDevWallet, syncDevWalletFile, getRpcUrl, patchEnvFile, REPO_ROOT } from './solana-lib.js';

const DEPLOY_DIR = join(REPO_ROOT, 'target', 'deploy');

const PROGRAM_ENV_KEYS: Record<string, string> = {
  worker_registry: 'WORKER_REGISTRY',
  job_router: 'JOB_ROUTER',
  dark_pool: 'DARK_POOL',
  ghst_staking: 'GHST_STAKING',
  fee_collector: 'FEE_COLLECTOR',
  attestation: 'ATTESTATION',
  governance: 'GOVERNANCE',
};

function run(cmd: string) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, SOLANA_RPC: getRpcUrl() },
  });
}

function deployProgram(name: string, rpc: string) {
  const so = join(DEPLOY_DIR, `${name}.so`);
  const keypair = join(DEPLOY_DIR, `${name}-keypair.json`);
  run(
    `solana program deploy "${so}" --program-id "${keypair}" --url "${rpc}" -k .keys/dev-wallet.json --max-sign-attempts 50`,
  );
}

function parseProgramIdsFromAnchorToml(): Record<string, string> {
  const toml = readFileSync(join(REPO_ROOT, 'Anchor.toml'), 'utf8');
  const ids: Record<string, string> = {};
  let inDevnet = false;
  for (const line of toml.split('\n')) {
    if (line.trim() === '[programs.devnet]') {
      inDevnet = true;
      continue;
    }
    if (inDevnet && line.startsWith('[')) break;
    if (!inDevnet) continue;
    const m = line.match(/^(\w+)\s*=\s*"([^"]+)"/);
    if (m) ids[m[1]!] = m[2]!;
  }
  return ids;
}

async function main() {
  const wallet = syncDevWalletFile();
  const rpc = getRpcUrl();
  console.log(`Deploy wallet: ${wallet.publicKey.toBase58()}`);
  console.log(`RPC: ${rpc}`);

  run('anchor build');

  try {
    run('anchor keys sync');
  } catch {
    console.warn('anchor keys sync skipped (IDs may already match)');
  }

  const programs = readdirSync(DEPLOY_DIR)
    .filter((f) => f.endsWith('.so'))
    .map((f) => f.replace(/\.so$/, ''))
    .sort();

  for (const program of programs) {
    console.log(`\n── Deploying ${program} ──`);
    deployProgram(program, rpc);
  }

  const ids = parseProgramIdsFromAnchorToml();
  const envUpdates: Record<string, string> = {};
  for (const [program, envKey] of Object.entries(PROGRAM_ENV_KEYS)) {
    const id = ids[program];
    if (id) envUpdates[envKey] = id;
  }

  if (existsSync(join(REPO_ROOT, '.env'))) {
    patchEnvFile(envUpdates);
    console.log('\n✓ Updated .env with program IDs:');
    for (const [k, v] of Object.entries(envUpdates)) console.log(`  ${k}=${v}`);
  } else {
    console.log('\nProgram IDs (add to .env):');
    for (const [k, v] of Object.entries(envUpdates)) console.log(`${k}=${v}`);
  }
}

main().catch((err) => {
  console.error('\nDeploy failed:', err);
  process.exit(1);
});
