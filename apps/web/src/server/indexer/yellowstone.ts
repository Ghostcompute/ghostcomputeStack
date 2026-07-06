// L8 — Real-time chain indexer via Yellowstone gRPC (Helius / Triton Dragon's Mouth).

import bs58 from 'bs58';
import { getProgramIds } from '@ghost-compute/solana';
import { buildProgramPubkeyMap, insertChainEvent } from './chain-events.js';

function sigToBase58(sig: Uint8Array | string | undefined): string | null {
  if (!sig) return null;
  if (typeof sig === 'string') return sig;
  return bs58.encode(sig);
}

function instructionForTx(
  accountKeys: string[],
  programMap: Record<string, string>,
): { programId: string; instruction: string } | null {
  for (const key of accountKeys) {
    const label = programMap[key];
    if (label) return { programId: key, instruction: label };
  }
  return null;
}

export function isYellowstoneConfigured(): boolean {
  return Boolean(process.env.YELLOWSTONE_ENDPOINT?.trim());
}

/** Yellowstone gRPC NAPI bindings are not published for Windows. */
export function isYellowstoneSupported(): boolean {
  return process.platform !== 'win32';
}

export function isYellowstoneEnabled(): boolean {
  return isYellowstoneConfigured() && isYellowstoneSupported();
}

let yellowstoneDisabled = false;

export async function startYellowstoneIndexer(): Promise<void> {
  const endpoint = process.env.YELLOWSTONE_ENDPOINT?.trim();
  if (!endpoint || yellowstoneDisabled) return;

  if (!isYellowstoneSupported()) {
    console.warn(
      '[yellowstone] skipped on Windows (no native gRPC binding) — enable CHAIN_INDEXER_ENABLED=true for RPC polling',
    );
    return;
  }

  const xToken = process.env.YELLOWSTONE_X_TOKEN?.trim() ?? undefined;
  const programs = getProgramIds();
  const programMap = buildProgramPubkeyMap(programs);
  const programIds = Object.keys(programMap);

  const connect = async () => {
    if (yellowstoneDisabled) return;

    const { default: Client } = await import('@triton-one/yellowstone-grpc');
    const client = new Client(endpoint, xToken, undefined);
    await client.connect();
    const stream = await client.subscribe();

    stream.on('data', async (update) => {
      const txWrap = update.transaction;
      if (!txWrap?.transaction) return;

      const sig = sigToBase58(txWrap.transaction.signature as Uint8Array | string | undefined);
      if (!sig) return;

      const accountKeys: string[] = [];
      const msg = txWrap.transaction.transaction?.message;
      if (msg?.accountKeys) {
        for (const k of msg.accountKeys) {
          accountKeys.push(typeof k === 'string' ? k : bs58.encode(k));
        }
      }

      const match = instructionForTx(accountKeys, programMap);
      if (!match) return;

      const inserted = await insertChainEvent({
        signature: sig,
        slot: txWrap.slot ?? null,
        programId: match.programId,
        instruction: match.instruction,
        meta: {
          source: 'yellowstone',
          err: txWrap.transaction.meta?.err ?? null,
        },
      });
      if (inserted) {
        console.log(`[yellowstone] ${match.instruction} → ${sig.slice(0, 16)}…`);
      }
    });

    stream.on('error', (err) => {
      console.error('[yellowstone] stream error:', (err as Error).message);
    });

    stream.on('end', () => {
      if (yellowstoneDisabled) return;
      console.warn('[yellowstone] stream ended — reconnecting in 5s');
      setTimeout(() => { connect().catch(onConnectError); }, 5000);
    });

    const request = {
      accounts: {},
      slots: {},
      transactions: {
        ghost_programs: {
          vote: false,
          failed: false,
          accountInclude: programIds,
          accountExclude: [],
          accountRequired: [],
        },
      },
      transactionsStatus: {},
      entry: {},
      blocks: {},
      blocksMeta: {},
      accountsDataSlice: [],
      commitment: 1, // CONFIRMED
    };

    await new Promise<void>((resolve, reject) => {
      stream.write(request, (err) => (err ? reject(err) : resolve()));
    });

    console.log(`[yellowstone] subscribed to ${programIds.length} program(s) at ${endpoint}`);
  };

  function onConnectError(err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.error('[yellowstone] connect failed:', msg);

    if (msg.includes('Cannot find native binding')) {
      yellowstoneDisabled = true;
      console.warn(
        '[yellowstone] disabled (native binding unavailable) — use CHAIN_INDEXER_ENABLED=true for RPC polling',
      );
      return;
    }

    if (yellowstoneDisabled) return;
    setTimeout(() => { startYellowstoneIndexer().catch(onConnectError); }, 10_000);
  }

  connect().catch(onConnectError);
}
