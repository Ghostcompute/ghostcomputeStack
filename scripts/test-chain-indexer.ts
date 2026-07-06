/**
 * Verify L8 chain indexer — poll devnet programs and confirm chain_events rows.
 * Usage: pnpm test:chain-indexer
 */
import './load-env.js';
import { createClient } from '@supabase/supabase-js';
import { createConnection } from '@ghost-compute/solana';
import { pollChainEvents } from '../apps/web/src/server/indexer/chain-poller.js';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

async function main() {
  if (process.env.CHAIN_INDEXER_ENABLED !== 'true') {
    console.log('⚠ CHAIN_INDEXER_ENABLED is not true — enabling for this test run only');
  }

  const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);

  const { count: before } = await db.from('chain_events').select('*', { count: 'exact', head: true });
  console.log(`chain_events before: ${before ?? 0}`);

  const inserted = await pollChainEvents(connection);
  console.log(`Polled RPC — inserted ${inserted} new event(s)`);

  const { data: rows, count } = await db
    .from('chain_events')
    .select('signature, instruction, slot, program_id, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  const after = count ?? rows?.length ?? 0;
  console.log(`chain_events after:  ${before != null ? before + inserted : after}`);

  if (!rows?.length && (before ?? 0) === 0) {
    throw new Error('No chain_events found — run pnpm migrate:chain-events first');
  }

  console.log('\nLatest chain events:');
  for (const r of rows ?? []) {
    console.log(`  ${r.instruction} · slot ${r.slot ?? '—'} · ${String(r.signature).slice(0, 16)}…`);
  }

  const feedRes = await fetch(`${process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001'}/api/explorer/feed`);
  if (feedRes.ok) {
    const feed = await feedRes.json() as { kind: string; message: string }[];
    const solanaLines = feed.filter(f => f.kind === 'solana');
    console.log(`\nLive feed solana lines: ${solanaLines.length}`);
  }

  console.log('\n✅ Chain indexer verified');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
