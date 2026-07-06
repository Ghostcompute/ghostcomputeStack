/**
 * Distribute accumulated GHST fees via FeeCollector::distribute.
 * Usage: pnpm distribute:fees
 */
import './load-env.js';
import {
  createConnection,
  distributeVaultBalanceIfReady,
  loadDevWallet,
} from '@ghost-compute/solana';

async function main() {
  const wallet = loadDevWallet();
  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);
  const min = BigInt(process.env.FEE_DISTRIBUTE_MIN_RAW ?? '51200');

  const sig = await distributeVaultBalanceIfReady(connection, wallet, min);
  if (sig) {
    console.log(`\n✅ Fee distribution tx: ${sig}`);
    console.log(`   https://solscan.io/tx/${sig}?cluster=devnet`);
  } else {
    console.log('\nNothing to distribute (vault below threshold or fee_vault missing).');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
