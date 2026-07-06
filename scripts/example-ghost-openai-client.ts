/**
 * Example: Ghost OpenAI client with automatic x402 GHST payment.
 * Usage: pnpm example:ghost-client
 *
 * Requires .env:
 *   ORCHESTRATOR_URL=http://localhost:3001
 *   DEV_WALLET=<base58 secret key with GHST + SOL on devnet>
 */
import './load-env.js';
import { createGhostClient, keypairFromSecret } from '@ghost-compute/openai-client';

const baseUrl = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const secret = process.env.DEV_WALLET ?? process.env.GHOST_PAYER_SECRET;
if (!secret) {
  console.error('Set DEV_WALLET or GHOST_PAYER_SECRET in .env');
  process.exit(1);
}

const client = createGhostClient({
  baseUrl,
  payer: keypairFromSecret(secret),
});

async function main() {
  const cfg = await client.getConfig();
  console.log(`Orchestrator: ${baseUrl}`);
  console.log(`Payer:        ${client.payer.publicKey.toBase58()}`);
  console.log(`GHST mint:    ${cfg.ghstMint}`);
  console.log(`Rate:         ${cfg.ghstPerOutputToken ?? '?'} GHST / output token`);
  console.log('');

  console.log('--- Non-streaming ---');
  const completion = await client.chat.completions.create({
    messages: [{ role: 'user', content: 'Reply with exactly: ghost client ok' }],
    max_tokens: 32,
    guarantee: 'standard',
  });
  console.log('Assistant:', completion.choices[0]?.message?.content);
  console.log('Settlement:', completion.x402_settlement ?? '(none)');
  console.log('');

  console.log('--- Streaming ---');
  process.stdout.write('Assistant: ');
  for await (const chunk of client.chat.completions.stream({
    messages: [{ role: 'user', content: 'Count from 1 to 5, one number per word.' }],
    max_tokens: 32,
  })) {
    process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
  }
  console.log('\n\n✓ Done');
}

main().catch((err) => {
  console.error('❌', err.message ?? err);
  process.exit(1);
});
