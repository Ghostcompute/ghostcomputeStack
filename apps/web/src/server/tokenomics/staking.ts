// GHST staking helpers — off-chain accounting layer
// On-chain state is canonical; this syncs from the ghst_staking Anchor program

import { createClient } from '@supabase/supabase-js';
import { awardPoints } from '../indexer/points.js';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

// FeeCollector split: 60% stakers / 20% workers / 10% burn / 10% treasury
export const FEE_SPLIT = {
  stakers:  60n,
  workers:  20n,
  burn:     10n,
  treasury: 10n,
} as const;

export function splitFees(totalRaw: bigint): {
  stakers: bigint; workers: bigint; burn: bigint; treasury: bigint;
} {
  const stakers  = (totalRaw * FEE_SPLIT.stakers)  / 100n;
  const workers  = (totalRaw * FEE_SPLIT.workers)  / 100n;
  const burn     = (totalRaw * FEE_SPLIT.burn)     / 100n;
  const treasury = totalRaw - stakers - workers - burn;  // remainder to treasury
  return { stakers, workers, burn, treasury };
}

export async function recordStake(pubkey: string, amountRaw: bigint): Promise<void> {
  await db.from('stakers').upsert({
    pubkey,
    staked_raw: amountRaw.toString(),
    staked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'pubkey' });
}

export async function distributeStakerRewards(stakerShareRaw: bigint): Promise<void> {
  const { data: stakers } = await db
    .from('stakers')
    .select('pubkey, staked_raw')
    .gt('staked_raw', '0');

  if (!stakers?.length) return;

  const totalStaked = stakers.reduce((s: bigint, r: any) => s + BigInt(r.staked_raw ?? 0), 0n);
  if (totalStaked === 0n) return;

  const updates = stakers.map((s: any) => {
    const share = (stakerShareRaw * BigInt(s.staked_raw)) / totalStaked;
    return { pubkey: s.pubkey, share };
  });

  for (const { pubkey, share } of updates) {
    await db.from('stakers').update({
      rewards_raw: db.rpc('increment_rewards', { inc: share.toString() }),
      updated_at: new Date().toISOString(),
    }).eq('pubkey', pubkey);

    // Award points proportional to stake (1 point per 1000 GHST staked)
    const staker = stakers.find((s: any) => s.pubkey === pubkey);
    if (staker) {
      const stakedThousands = BigInt(staker.staked_raw) / 1_000_000_000n;
      if (stakedThousands > 0n) {
        await awardPoints(pubkey, 'STAKE_GHST', undefined, stakedThousands);
      }
    }
  }
}

export async function getStakerInfo(pubkey: string) {
  const { data } = await db.from('stakers').select('*').eq('pubkey', pubkey).single();
  return data;
}
