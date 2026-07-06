/**
 * Test client-signed settlement tx path (simulates browser wallet payment).
 * Usage: pnpm test:x402:client
 */
import './load-env.js';
import {
  buildDevX402Receipt,
  buildGhstTransferTx,
  createConnection,
  encodeX402Payment,
  getFeeCollectorPayTo,
  getMintIds,
  loadDevWallet,
  parseX402Payment,
} from '@ghost-compute/solana';
import { PublicKey } from '@solana/web3.js';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';

async function main() {
  const payer = loadDevWallet();
  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);
  const payTo = getFeeCollectorPayTo();
  const asset = getMintIds().GHST.toBase58();

  const body = {
    messages: [{ role: 'user', content: 'Reply: client settlement ok' }],
    stream: false,
    max_tokens: 16,
  };

  const unpaid = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (unpaid.status !== 402) throw new Error(`Expected 402, got ${unpaid.status}`);
  const challenge = await unpaid.json();
  const accept = challenge.accepts?.[0];

  const receipt = buildDevX402Receipt(payer, accept.payTo, accept.asset, accept.maxAmountRequired);
  const tx = await buildGhstTransferTx(
    connection,
    payer.publicKey,
    BigInt(accept.maxAmountRequired),
    new PublicKey(accept.payTo),
  );
  tx.sign(payer);
  const settlementTx = Buffer.from(tx.serialize()).toString('base64');

  const header = encodeX402Payment({ receipt, settlement_tx: settlementTx });
  const parsed = parseX402Payment(header);
  if (!parsed?.settlement_tx) throw new Error('Payment envelope parse failed');

  const paid = await fetch(`${ORCHESTRATOR}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Payment': header },
    body: JSON.stringify(body),
  });

  const text = await paid.text();
  if (!paid.ok) throw new Error(`Failed ${paid.status}: ${text.slice(0, 400)}`);

  const sig = paid.headers.get('x-payment-response');
  console.log('✅ Client-signed settlement path OK');
  console.log(`   Settlement tx: ${sig}`);
  console.log(`   Response: ${JSON.parse(text).choices?.[0]?.message?.content?.slice(0, 80)}`);
}

main().catch((err) => {
  console.error('❌', err.message ?? err);
  process.exit(1);
});
