/**
 * Dark pool on-chain match test — crossing buy/sell with place_order + settle_match.
 * Usage: pnpm test:darkpool-onchain
 */
import './load-env.js';
import { loadDevWallet, getMintIds } from '@ghost-compute/solana';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const GHST = getMintIds().GHST.toBase58();
const USDC = getMintIds().USDC.toBase58();

async function submitOrder(side: 'buy' | 'sell', priceRaw: string, amountRaw: string) {
  const owner = loadDevWallet().publicKey.toBase58();
  const res = await fetch(`${ORCHESTRATOR}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      side,
      base_mint: GHST,
      quote_mint: USDC,
      amount: amountRaw,
      price: priceRaw,
      guarantee: 'standard',
      owner_pubkey: owner,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Order ${side} failed (${res.status}): ${JSON.stringify(body)}`);
  return body as { order_id: string };
}

async function getMatches() {
  const res = await fetch(`${ORCHESTRATOR}/api/darkpool/matches`);
  if (!res.ok) throw new Error(`matches HTTP ${res.status}`);
  return res.json() as Promise<Array<{
    id: string;
    buy_order_id: string;
    sell_order_id: string;
    fill_amount_raw: string;
    fill_price_raw: string;
    settled: boolean;
    on_chain_sig: string | null;
    created_at: string;
  }>>;
}

async function main() {
  if (process.env.DARK_POOL_ONCHAIN_ENABLED !== 'true') {
    throw new Error('Set DARK_POOL_ONCHAIN_ENABLED=true in .env and restart orchestrator');
  }

  const amountRaw = '1000000000';   // 1 GHST (9 decimals)
  const priceRaw = '1000000';       // 1 USDC (6 decimals)

  console.log(`Orchestrator: ${ORCHESTRATOR}`);
  console.log(`Pair: GHST/USDC · amount=${amountRaw} · price=${priceRaw}`);
  console.log(`Owner: ${loadDevWallet().publicKey.toBase58()}\n`);

  const before = await getMatches();
  console.log(`Matches before: ${before.length}`);

  console.log('→ Placing sell order…');
  const sell = await submitOrder('sell', priceRaw, amountRaw);
  console.log(`  sell order_id: ${sell.order_id}`);

  console.log('→ Placing crossing buy order…');
  const buy = await submitOrder('buy', priceRaw, amountRaw);
  console.log(`  buy order_id:  ${buy.order_id}`);

  // Allow async on-chain txs to finish
  await new Promise(r => setTimeout(r, 4000));

  const after = await getMatches();
  const match = after.find(m =>
    (m.buy_order_id === buy.order_id && m.sell_order_id === sell.order_id)
    || (m.buy_order_id === sell.order_id && m.sell_order_id === buy.order_id)
    || after.length > before.length,
  ) ?? after[0];

  if (!match || after.length <= before.length) {
    throw new Error('No new match recorded — check orchestrator logs for darkpool errors');
  }

  console.log('\nMatch recorded:');
  console.log(`  id:           ${match.id}`);
  console.log(`  fill_amount:  ${match.fill_amount_raw}`);
  console.log(`  fill_price:   ${match.fill_price_raw}`);
  console.log(`  settled:      ${match.settled}`);
  console.log(`  on_chain_sig: ${match.on_chain_sig ?? '(none)'}`);

  if (!match.on_chain_sig) {
    throw new Error('Match has no on_chain_sig — place_order/settle_match may have failed on devnet');
  }

  console.log(`\n✅ Dark pool on-chain match verified`);
  console.log(`   https://solscan.io/tx/${match.on_chain_sig}?cluster=devnet`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
