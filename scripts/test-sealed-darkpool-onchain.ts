/**
 * Sealed dark pool on-chain test — submit_sealed_order + settle_sealed_fill.
 * Usage: pnpm test:sealed-darkpool
 */
import './load-env.js';
import { loadDevWallet } from '@ghost-compute/solana';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const OWNER = loadDevWallet().publicKey.toBase58();

function sealedPayload(side: 'buy' | 'sell', amountRaw: string, priceRaw: string) {
  return Buffer.from(JSON.stringify({ side, amount_raw: amountRaw, price_raw: priceRaw })).toString('base64');
}

async function submitSealed(side: 'buy' | 'sell') {
  const res = await fetch(`${ORCHESTRATOR}/api/orders/sealed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_pubkey: OWNER,
      ciphertext: sealedPayload(side, '1000000000', '1000000'),
      margin: '500000000',
      guarantee: 'high',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sealed ${side} failed (${res.status}): ${JSON.stringify(body)}`);
  return body as { order_id: string };
}

async function main() {
  if (process.env.DARK_POOL_ONCHAIN_ENABLED !== 'true') {
    throw new Error('Set DARK_POOL_ONCHAIN_ENABLED=true and restart orchestrator');
  }

  console.log(`Orchestrator: ${ORCHESTRATOR}`);
  console.log(`Owner: ${OWNER}\n`);

  const before = await fetch(`${ORCHESTRATOR}/api/darkpool/matches`).then(r => r.json()) as unknown[];
  console.log(`Matches before: ${before.length}`);

  console.log('→ Sealed sell…');
  const sell = await submitSealed('sell');
  console.log(`  order_id: ${sell.order_id}`);

  console.log('→ Sealed buy (should match)…');
  const buy = await submitSealed('buy');
  console.log(`  order_id: ${buy.order_id}`);

  await new Promise(r => setTimeout(r, 3000));

  const after = await fetch(`${ORCHESTRATOR}/api/darkpool/matches`).then(r => r.json()) as Array<{
    id: string;
    settled: boolean;
    on_chain_sig: string | null;
  }>;
  const match = after.find(m => m.id) ?? after[0];

  if (after.length <= before.length) {
    throw new Error('No sealed match recorded');
  }

  console.log('\nMatch:');
  console.log(`  id:           ${match.id}`);
  console.log(`  settled:      ${match.settled}`);
  console.log(`  on_chain_sig: ${match.on_chain_sig ?? '(none)'}`);

  const sealed = await fetch(`${ORCHESTRATOR}/api/darkpool/sealed`).then(r => r.json()) as unknown[];
  console.log(`\nSealed orders in DB: ${sealed.length}`);

  if (!match.on_chain_sig) {
    throw new Error('Sealed match missing on_chain_sig');
  }

  console.log('\n✅ Sealed dark pool on-chain verified');
  console.log(`   https://solscan.io/tx/${match.on_chain_sig}?cluster=devnet`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
