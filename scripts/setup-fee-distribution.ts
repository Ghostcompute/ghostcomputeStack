/**
 * Create fee distribution destination ATAs + init fee_vault PDA.
 * Usage: pnpm setup:fee-distribution
 */
import './load-env.js';
import { Keypair } from '@solana/web3.js';
import {
  createConnection,
  ensureFeeDestinationAtas,
  initializeFeeVaultIfNeeded,
  loadDevWallet,
} from '@ghost-compute/solana';
import { patchEnvFile } from './solana-lib.js';

async function main() {
  const wallet = loadDevWallet();
  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);

  const updates: Record<string, string> = {};

  for (const key of ['STAKER_POOL', 'WORKER_PAYOUT', 'BURN_VAULT', 'TREASURY'] as const) {
    if (!process.env[key]?.trim()) {
      const kp = Keypair.generate();
      updates[key] = kp.publicKey.toBase58();
      console.log(`Generated ${key}: ${kp.publicKey.toBase58()}`);
    }
  }

  if (Object.keys(updates).length) {
    patchEnvFile(updates);
    Object.assign(process.env, updates);
  }

  console.log(`Payer: ${wallet.publicKey.toBase58()}`);

  await initializeFeeVaultIfNeeded(connection, wallet);
  console.log('✓ fee_vault PDA initialized (or already exists)');

  const dests = await ensureFeeDestinationAtas(connection, wallet);
  console.log('\n✓ Fee distribution ATAs ready');
  console.log(`  Staker pool:  ${dests.stakerPool.toBase58()}`);
  console.log(`  Worker payout: ${dests.workerPayout.toBase58()}`);
  console.log(`  Burn vault:   ${dests.burnVault.toBase58()}`);
  console.log(`  Treasury:     ${dests.treasury.toBase58()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
