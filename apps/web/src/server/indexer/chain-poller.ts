// L8 — Poll devnet program accounts for recent signatures and persist to chain_events.

import { Connection, PublicKey } from '@solana/web3.js';
import { createConnection, getProgramIds } from '@ghost-compute/solana';
import { insertChainEvent, PROGRAM_LABELS } from './chain-events.js';
import {
  isYellowstoneConfigured,
  isYellowstoneEnabled,
  isYellowstoneSupported,
} from './yellowstone.js';

export { isYellowstoneEnabled } from './yellowstone.js';

export function isChainIndexerEnabled(): boolean {
  return process.env.CHAIN_INDEXER_ENABLED === 'true';
}

function shouldUseRpcPoller(): boolean {
  if (isChainIndexerEnabled()) return true;
  // Windows dev: Yellowstone gRPC is unavailable — poll over RPC instead.
  return isYellowstoneConfigured() && !isYellowstoneSupported();
}

export async function pollChainEvents(connection: Connection): Promise<number> {
  const programs = getProgramIds();
  let inserted = 0;

  for (const [key, programId] of Object.entries(programs) as [keyof typeof programs, PublicKey][]) {
    let sigs;
    try {
      sigs = await connection.getSignaturesForAddress(programId, { limit: 25 });
    } catch (err) {
      console.warn(`[indexer] getSignaturesForAddress ${key}:`, (err as Error).message);
      continue;
    }

    for (const s of sigs) {
      if (!s.signature) continue;

      const ok = await insertChainEvent({
        signature: s.signature,
        slot: s.slot ?? null,
        programId: programId.toBase58(),
        instruction: PROGRAM_LABELS[key] ?? key,
        meta: { err: s.err, memo: s.memo ?? null, source: 'poller' },
      });
      if (ok) inserted++;
    }
  }

  if (inserted) console.log(`[indexer] stored ${inserted} new chain event(s)`);
  return inserted;
}

export function startChainIndexer(): void {
  if (isYellowstoneEnabled()) {
    import('./yellowstone.js')
      .then(m => m.startYellowstoneIndexer())
      .catch(err => console.error('[yellowstone]', (err as Error).message));
    return;
  }

  if (!shouldUseRpcPoller()) return;

  const rpc = process.env.SOLANA_RPC ?? process.env.HELIUS_RPC ?? 'https://api.devnet.solana.com';
  const connection = createConnection(rpc);
  const intervalMs = Number(process.env.CHAIN_INDEXER_INTERVAL_MS ?? 60_000);

  const tick = () => {
    pollChainEvents(connection).catch(err => console.error('[indexer]', err.message));
  };

  if (isYellowstoneConfigured() && !isYellowstoneSupported()) {
    console.log(
      `[indexer] Yellowstone unavailable on ${process.platform} — using RPC poller (${rpc}, every ${intervalMs}ms)`,
    );
  } else {
    console.log(`[indexer] chain poller started (${rpc}, every ${intervalMs}ms)`);
  }

  tick();
  setInterval(tick, intervalMs);
}
