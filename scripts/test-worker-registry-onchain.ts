/**
 * Register worker on-chain via worker_registry (dev: WORKER_PUBKEY must match DEV_WALLET).
 * Usage: pnpm test:worker-registry
 */
import './load-env.js';
import {
  createConnection,
  loadDevWallet,
  registerWorkerOnChain,
  workerRegistryAccountExists,
  isWorkerRegistryOnChainEnabled,
} from '@ghost-compute/solana';

async function main() {
  if (!isWorkerRegistryOnChainEnabled()) {
    throw new Error('Set WORKER_REGISTRY_ONCHAIN_ENABLED=true in .env');
  }

  const dev = loadDevWallet();
  const useDev = process.argv.includes('--use-dev-wallet');
  const workerPubkey = useDev ? dev.publicKey.toBase58() : process.env.WORKER_PUBKEY?.trim();
  if (workerPubkey !== dev.publicKey.toBase58()) {
    throw new Error(
      `WORKER_PUBKEY must match DEV_WALLET for dev on-chain registration.\n` +
      `  WORKER_PUBKEY: ${workerPubkey}\n` +
      `  DEV_WALLET:    ${dev.publicKey.toBase58()}`,
    );
  }

  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);
  const model = process.env.DEFAULT_MODEL ?? 'Qwen/Qwen3.5-9B';

  const already = await workerRegistryAccountExists(connection, dev.publicKey);
  const sig = await registerWorkerOnChain(
    connection,
    dev,
    model,
    100,
    process.env.TEE_TYPE ?? 'none',
    Number(process.env.VRAM_GB ?? 80),
  );

  if (sig) {
    console.log('\n✅ Worker registered on-chain');
    console.log(`   https://solscan.io/tx/${sig}?cluster=devnet`);
  } else if (already || await workerRegistryAccountExists(connection, dev.publicKey)) {
    console.log('\n✅ Worker already registered on-chain (idempotent pass)');
    console.log(`   Worker PDA: ${dev.publicKey.toBase58()}`);
  } else {
    throw new Error('Registration returned no signature and account not found');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
