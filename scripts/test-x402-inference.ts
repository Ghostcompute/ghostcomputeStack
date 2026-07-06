/**
 * End-to-end x402 inference test:
 * 1. POST without payment → 402 challenge
 * 2. Sign receipt with DEV_WALLET
 * 3. POST with X-Payment → 200 completion
 *
 * Usage: pnpm test:x402
 */
import './load-env.js';
import {
  buildDevX402Receipt,
  encodeX402Header,
  getFeeCollectorPayTo,
  getMintIds,
  parseX402Header,
} from '@ghost-compute/solana';
import { loadDevWallet } from '@ghost-compute/solana';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const GHST_PRICE_PER_TOK = 100n;

async function main() {
  const payTo = getFeeCollectorPayTo();
  const asset = getMintIds().GHST.toBase58();
  const payer = loadDevWallet();

  console.log(`Orchestrator: ${ORCHESTRATOR}`);
  console.log(`Payer:        ${payer.publicKey.toBase58()}`);
  console.log(`Pay to:       ${payTo}`);
  console.log(`Asset (GHST): ${asset}`);

  const body = {
    messages: [{ role: 'user', content: 'Say "x402 ok" and nothing else.' }],
    stream: false,
    max_tokens: 32,
  };

  // Step 1 — expect 402
  const unpaid = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (unpaid.status !== 402) {
    const text = await unpaid.text();
    throw new Error(`Expected 402, got ${unpaid.status}: ${text.slice(0, 300)}`);
  }

  const challenge = await unpaid.json();
  const accept = challenge.accepts?.[0];
  console.log('\n✓ Received 402 challenge');
  console.log(`  maxAmountRequired: ${accept?.maxAmountRequired}`);
  console.log(`  payTo:             ${accept?.payTo}`);
  console.log(`  asset:             ${accept?.asset}`);

  const required = BigInt(accept?.maxAmountRequired ?? '0');
  if (required <= 0n) throw new Error('Invalid challenge amount');

  // Step 2 — sign receipt
  const receipt = buildDevX402Receipt(
    payer,
    accept.payTo,
    accept.asset,
    accept.maxAmountRequired,
  );
  const paymentHeader = encodeX402Header(receipt);
  console.log('\n✓ Signed x402 receipt');

  // Step 3 — paid request
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
    throw new Error(`Paid request failed ${paid.status}: ${paidText.slice(0, 500)}`);
  }

  const result = JSON.parse(paidText);
  const content = result.choices?.[0]?.message?.content ?? '';
  console.log('\n✓ Inference succeeded (200)');
  console.log(`  Response: ${content.slice(0, 200)}`);
  console.log(`  Tokens:   ${result.usage?.completion_tokens ?? '?'}`);

  // Sanity: round-trip header parse
  const parsed = parseX402Header(paymentHeader);
  if (!parsed?.signature) throw new Error('Receipt round-trip failed');
  console.log('\n✅ x402 inference e2e test passed');
}

main().catch((err) => {
  console.error('\n❌ x402 test failed:', err.message ?? err);
  process.exit(1);
});
