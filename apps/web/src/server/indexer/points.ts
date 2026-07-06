// Points ledger: records on-chain events and awards points to pubkeys
// Called by the settlement relayer and job router on key events

import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

export const POINT_VALUES = {
  JOB_COMPLETED:    10n,
  JOB_TEE_BONUS:    5n,    // extra for TEE-verified jobs
  DARK_ORDER_MATCH: 20n,
  STAKE_GHST:       1n,    // per 1000 GHST staked (daily)
  REFERRAL:         50n,
} as const;

export type PointEvent = keyof typeof POINT_VALUES;

export async function awardPoints(
  pubkey: string,
  event: PointEvent,
  refId?: string,
  multiplier = 1n,
): Promise<void> {
  const points = POINT_VALUES[event] * multiplier;

  await db.from('points_ledger').insert({
    pubkey,
    event_type: event,
    points: points.toString(),
    ref_id: refId ?? null,
  });
}

export async function getLeaderboard(limit = 100): Promise<Array<{ pubkey: string; total: bigint }>> {
  const { data } = await db
    .from('points_ledger')
    .select('pubkey, points')
    .order('created_at', { ascending: false });

  if (!data?.length) return [];

  const totals = new Map<string, bigint>();
  for (const row of data) {
    const cur = totals.get(row.pubkey) ?? 0n;
    totals.set(row.pubkey, cur + BigInt(row.points ?? 0));
  }

  return [...totals.entries()]
    .map(([pubkey, total]) => ({ pubkey, total }))
    .sort((a, b) => (b.total > a.total ? 1 : -1))
    .slice(0, limit);
}

export async function getPoints(pubkey: string): Promise<bigint> {
  const { data } = await db
    .from('points_ledger')
    .select('points')
    .eq('pubkey', pubkey);

  return (data ?? []).reduce((s, r) => s + BigInt(r.points ?? 0), 0n);
}
