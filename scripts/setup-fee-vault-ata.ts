/**
 * Create fee-vault GHST ATA (+ payer ATA) on devnet for x402 settlement.
 * Usage: pnpm setup:fee-ata
 */
import './load-env.js';
import {
  createConnection,
  ensureGhstSettlementAccounts,
  getFeeCollectorGhstAta,
  getFeeCollectorPayTo,
  getFeeVaultPdaAddress,
  getPayerGhstAta,
  getTokenAccountBalanceRaw,
  loadDevWallet,
} from '@ghost-compute/solana';
import { patchEnvFile } from './solana-lib.js';

async function main() {
  const wallet = loadDevWallet();
  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);

  console.log(`Payer: ${wallet.publicKey.toBase58()}`);
  console.log(`Fee vault PDA: ${getFeeVaultPdaAddress()}`);

  const { feeVaultAta, payerAta, tokenProgram } = await ensureGhstSettlementAccounts(connection, wallet);

  const payerBal = await getTokenAccountBalanceRaw(connection, payerAta);
  const vaultBal = await getTokenAccountBalanceRaw(connection, feeVaultAta);

  console.log('\n✓ Settlement accounts ready');
  console.log(`  Token program:     ${tokenProgram.toBase58()}`);
  console.log(`  Fee vault GHST ATA: ${feeVaultAta.toBase58()}`);
  console.log(`  Payer GHST ATA:     ${payerAta.toBase58()}`);
  console.log(`  Payer GHST balance: ${payerBal}`);
  console.log(`  Vault GHST balance: ${vaultBal}`);
  console.log(`  x402 payTo:         ${getFeeCollectorPayTo()}`);

  patchEnvFile({
    FEE_COLLECTOR_GHST_ATA: feeVaultAta.toBase58(),
    FEE_COLLECTOR_PDA: getFeeVaultPdaAddress(),
  });
  console.log('\n✓ Updated .env → FEE_COLLECTOR_GHST_ATA, FEE_COLLECTOR_PDA');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
