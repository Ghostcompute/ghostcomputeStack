/**
 * Full x402 + on-chain GHST settlement test.
 * Usage: pnpm test:x402:settlement
 */
import './load-env.js';
import {
  buildDevX402Receipt,
  createConnection,
  encodeX402Header,
  getFeeCollectorPayTo,
  getMintIds,
  getPayerGhstAta,
  getFeeCollectorGhstAta,
  getTokenAccountBalanceRaw,
  loadDevWallet,
  parseX402Header,
} from '@ghost-compute/solana';
import { patchEnvFile } from './solana-lib.js';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';

async function main() {
  if (process.env.SOLANA_SETTLEMENT_ENABLED !== 'true') {
    patchEnvFile({ SOLANA_SETTLEMENT_ENABLED: 'true' });
    console.log('Enabled SOLANA_SETTLEMENT_ENABLED in .env — restart orchestrator after this test if it was running.');
  }

  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);
  const payer = loadDevWallet();
  const payTo = getFeeCollectorPayTo();
  const asset = getMintIds().GHST.toBase58();
  const payerAta = getPayerGhstAta(payer.publicKey);
  const vaultAta = getFeeCollectorGhstAta();

  const balBeforePayer = await getTokenAccountBalanceRaw(connection, payerAta);
  const balBeforeVault = await getTokenAccountBalanceRaw(connection, vaultAta);

  console.log(`Orchestrator: ${ORCHESTRATOR}`);
  console.log(`Payer:        ${payer.publicKey.toBase58()}`);
  console.log(`Pay to ATA:   ${payTo}`);
  console.log(`GHST mint:    ${asset}`);
  console.log(`Payer GHST:   ${balBeforePayer} (before)`);
  console.log(`Vault GHST:   ${balBeforeVault} (before)`);

  if (balBeforePayer < 51_200n) {
    throw new Error(`Payer needs ≥51200 GHST raw units for test; have ${balBeforePayer}`);
  }

  const body = {
    messages: [{ role: 'user', content: 'Reply with exactly: settlement ok' }],
    stream: false,
    max_tokens: 24,
  };

  const unpaid = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (unpaid.status !== 402) {
    throw new Error(`Expected 402, got ${unpaid.status}: ${await unpaid.text()}`);
  }
  const challenge = await unpaid.json();
  const accept = challenge.accepts?.[0];
  console.log('\n✓ 402 challenge received');

  const receipt = buildDevX402Receipt(payer, accept.payTo, accept.asset, accept.maxAmountRequired);
  const paymentHeader = encodeX402Header(receipt);

  const paid = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': paymentHeader,
    },
    body: JSON.stringify(body),
  });

  const paidText = await paid.text();
  if (!paid.ok) {
    throw new Error(`Paid request failed ${paid.status}: ${paidText.slice(0, 600)}`);
  }

  const result = JSON.parse(paidText);
  const settlementSig = paid.headers.get('x-payment-response') ?? result.x402_settlement;
  console.log('\n✓ Inference 200');
  console.log(`  Settlement tx: ${settlementSig ?? '(missing)'}`);
  console.log(`  Response:      ${(result.choices?.[0]?.message?.content ?? '').slice(0, 120)}`);

  if (!settlementSig || settlementSig === 'deduped') {
    throw new Error('Missing on-chain settlement signature — is SOLANA_SETTLEMENT_ENABLED=true on orchestrator?');
  }

  await new Promise((r) => setTimeout(r, 2000));

  const balAfterPayer = await getTokenAccountBalanceRaw(connection, payerAta);
  const balAfterVault = await getTokenAccountBalanceRaw(connection, vaultAta);
  const paidAmount = BigInt(accept.maxAmountRequired);

  console.log('\nBalances after settlement:');
  console.log(`  Payer: ${balBeforePayer} → ${balAfterPayer} (Δ ${balAfterPayer - balBeforePayer})`);
  console.log(`  Vault: ${balBeforeVault} → ${balAfterVault} (Δ ${balAfterVault - balBeforeVault})`);

  if (balAfterVault - balBeforeVault < paidAmount) {
    throw new Error('Vault balance did not increase by payment amount');
  }
  if (balBeforePayer - balAfterPayer < paidAmount) {
    throw new Error('Payer balance did not decrease by payment amount');
  }

  const parsed = parseX402Header(paymentHeader);
  if (!parsed) throw new Error('Receipt parse failed');

  console.log(`\n✅ x402 + on-chain GHST settlement verified`);
  console.log(`   https://solscan.io/tx/${settlementSig}?cluster=devnet`);
}

main().catch((err) => {
  console.error('\n❌ Settlement test failed:', err.message ?? err);
  process.exit(1);
});
