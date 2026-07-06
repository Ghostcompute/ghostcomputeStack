import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let db: SupabaseClient | null = null;

function getDb(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE?.trim();
  if (!url || !key) return null;
  if (!db) db = createClient(url, key);
  return db;
}

const memoryNonces = new Set<string>();

export interface NonceRecord {
  nonce: string;
  tx_signature: string;
}

/** Check if nonce was already settled (Supabase with in-memory fallback). */
export async function lookupSettledNonce(nonce: string): Promise<NonceRecord | null> {
  const supabase = getDb();
  if (supabase) {
    const { data } = await supabase
      .from('x402_settlements')
      .select('nonce, tx_signature')
      .eq('nonce', nonce)
      .maybeSingle();
    if (data) return data as NonceRecord;
  }
  if (memoryNonces.has(nonce)) {
    return { nonce, tx_signature: 'deduped' };
  }
  return null;
}

/** Persist settlement nonce; returns false if duplicate. */
export async function recordSettledNonce(
  nonce: string,
  payer: string,
  amountRaw: string,
  txSignature: string,
): Promise<'inserted' | 'duplicate'> {
  const supabase = getDb();
  if (supabase) {
    const { error } = await supabase.from('x402_settlements').insert({
      nonce,
      payer,
      amount_raw: amountRaw,
      tx_signature: txSignature,
    });
    if (error?.code === '23505') return 'duplicate';
    if (error?.code === 'PGRST205' || error?.message?.includes('x402_settlements')) {
      // Table not migrated yet — fall through to in-memory dedup
    } else if (error) {
      console.error('[nonce-store] Supabase insert failed:', error.message);
    } else {
      return 'inserted';
    }
  }
  if (memoryNonces.has(nonce)) return 'duplicate';
  memoryNonces.add(nonce);
  return 'inserted';
}
