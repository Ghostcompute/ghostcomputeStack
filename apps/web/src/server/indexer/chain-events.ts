import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE ?? '',
);

export const PROGRAM_LABELS: Record<string, string> = {
  WORKER_REGISTRY: 'worker_registry',
  JOB_ROUTER: 'job_router',
  DARK_POOL: 'dark_pool',
  GHST_STAKING: 'ghst_staking',
  FEE_COLLECTOR: 'fee_collector',
  ATTESTATION: 'attestation',
  GOVERNANCE: 'governance',
};

export function programLabelForPubkey(
  programId: string,
  programMap: Record<string, string>,
): string {
  return programMap[programId] ?? 'unknown';
}

export function buildProgramPubkeyMap(
  programs: Record<string, { toBase58(): string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, pk] of Object.entries(programs)) {
    map[pk.toBase58()] = PROGRAM_LABELS[key] ?? key.toLowerCase();
  }
  return map;
}

/** Persist a chain event if the signature is new. Returns true when inserted. */
export async function insertChainEvent(params: {
  signature: string;
  slot: number | null;
  programId: string;
  instruction: string;
  meta?: Record<string, unknown>;
}): Promise<boolean> {
  const { data: existing } = await db
    .from('chain_events')
    .select('id')
    .eq('signature', params.signature)
    .maybeSingle();
  if (existing) return false;

  const { error } = await db.from('chain_events').insert({
    signature: params.signature,
    slot: params.slot,
    program_id: params.programId,
    instruction: params.instruction,
    meta: params.meta ?? {},
  });
  return !error;
}
