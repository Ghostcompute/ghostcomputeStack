// Sealed dark-pool orders — commitment + ciphertext in DB, optional on-chain PDA.

import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Guarantee } from '@ghost-compute/shared';
import {
  createConnection,
  isDarkPoolOnChainEnabled,
  resolveDarkPoolOracle,
  settleSealedFillOnChain,
  submitSealedOrderOnChain,
} from '@ghost-compute/solana';
import { audit } from '../attestation/service.js';
import { getMintIds } from '@ghost-compute/solana';

const GHST_MINT = () => getMintIds().GHST.toBase58();
const USDC_MINT = () => getMintIds().USDC.toBase58();

interface SealedOrderRecord {
  id: string;
  owner_pubkey: string;
  commit_hash: string;
  ciphertext: string;
  margin_raw: bigint;
  guarantee: string;
  side: 'buy' | 'sell';
  amount_raw: bigint;
  price_raw: bigint;
  created_at: number;
}

/** Dev decoder — production uses enclave/MPC reveal at match time. */
function decodeSealedPayload(ciphertext: string): {
  side: 'buy' | 'sell';
  amount_raw: bigint;
  price_raw: bigint;
} | null {
  try {
    const json = JSON.parse(Buffer.from(ciphertext, 'base64').toString('utf8'));
    if (json.side !== 'buy' && json.side !== 'sell') return null;
    return {
      side: json.side,
      amount_raw: BigInt(json.amount_raw ?? json.amount ?? '0'),
      price_raw: BigInt(json.price_raw ?? json.price ?? '0'),
    };
  } catch {
    return null;
  }
}

export function encodeSealedPayload(
  side: 'buy' | 'sell',
  amountRaw: string,
  priceRaw: string,
): string {
  return Buffer.from(JSON.stringify({
    side,
    amount_raw: amountRaw,
    price_raw: priceRaw,
  })).toString('base64');
}

export class SealedDarkPool {
  private book = new Map<string, SealedOrderRecord>();

  constructor(private db: SupabaseClient) {}

  async submitSealedOrder(dto: {
    owner_pubkey: string;
    ciphertext: string;
    margin: string;
    guarantee?: string;
  }): Promise<string> {
    const decoded = decodeSealedPayload(dto.ciphertext);
    if (!decoded) throw new Error('sealed order: invalid ciphertext payload');

    const orderId = crypto.randomUUID();
    const commitHash = crypto.createHash('sha256').update(dto.ciphertext).digest('hex');
    const guarantee = dto.guarantee ?? Guarantee.High;
    const marginRaw = BigInt(dto.margin);

    const record: SealedOrderRecord = {
      id: orderId,
      owner_pubkey: dto.owner_pubkey,
      commit_hash: commitHash,
      ciphertext: dto.ciphertext,
      margin_raw: marginRaw,
      guarantee,
      ...decoded,
      created_at: Date.now(),
    };
    this.book.set(orderId, record);

    const { error: sealedErr } = await this.db.from('sealed_orders').insert({
      id: orderId,
      order_id: orderId,
      owner_pubkey: dto.owner_pubkey,
      commit_hash: commitHash,
      ciphertext: dto.ciphertext,
      margin_raw: marginRaw.toString(),
      guarantee,
      status: 'sealed',
    });
    if (sealedErr) throw new Error(`sealed_orders insert: ${sealedErr.message}`);

    const { error: orderErr } = await this.db.from('dark_orders').insert({
      id: orderId,
      side: decoded.side,
      base_mint: GHST_MINT(),
      quote_mint: USDC_MINT(),
      amount_raw: decoded.amount_raw.toString(),
      price_raw: decoded.price_raw.toString(),
      owner_pubkey: dto.owner_pubkey,
      guarantee,
      status: 'open',
    });
    if (orderErr) throw new Error(`dark_orders insert: ${orderErr.message}`);

    if (isDarkPoolOnChainEnabled()) {
      const oracle = resolveDarkPoolOracle();
      if (oracle) {
        try {
          const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
          await submitSealedOrderOnChain(
            createConnection(rpc),
            oracle,
            orderId,
            commitHash,
            marginRaw,
            guarantee,
          );
        } catch (err) {
          console.error('[sealed-pool] on-chain submit failed:', (err as Error).message);
        }
      }
    }

    await this.tryMatch(record);
    return orderId;
  }

  private pricesCross(buy: SealedOrderRecord, sell: SealedOrderRecord): boolean {
    return buy.price_raw >= sell.price_raw;
  }

  private async tryMatch(newOrder: SealedOrderRecord) {
    const opposite = newOrder.side === 'buy' ? 'sell' : 'buy';
    const candidates = [...this.book.values()].filter(o =>
      o.id !== newOrder.id &&
      o.side === opposite &&
      this.pricesCross(
        newOrder.side === 'buy' ? newOrder : o,
        newOrder.side === 'sell' ? newOrder : o,
      ),
    );
    if (!candidates.length) return;

    const match = candidates[0];
    const buy = newOrder.side === 'buy' ? newOrder : match;
    const sell = newOrder.side === 'sell' ? newOrder : match;
    const fillAmount = buy.amount_raw < sell.amount_raw ? buy.amount_raw : sell.amount_raw;
    const fillPrice = (buy.price_raw + sell.price_raw) / 2n;
    const matchId = crypto.randomUUID();

    this.book.delete(buy.id);
    this.book.delete(sell.id);

    let onChainSig: string | null = null;
    if (isDarkPoolOnChainEnabled()) {
      const oracle = resolveDarkPoolOracle();
      if (oracle) {
        try {
          const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
          onChainSig = await settleSealedFillOnChain(
            createConnection(rpc),
            oracle,
            matchId,
            buy.id,
            sell.id,
            fillAmount,
            fillPrice,
          );
        } catch (err) {
          console.error('[sealed-pool] on-chain settle failed:', (err as Error).message);
        }
      }
    }

    await this.db.from('sealed_orders').update({ status: 'matched' }).in('id', [buy.id, sell.id]);
    await this.db.from('dark_orders').update({ status: 'matched', match_id: matchId })
      .in('id', [buy.id, sell.id]);

    const { error: matchErr } = await this.db.from('dark_matches').insert({
      id: matchId,
      buy_order_id: buy.id,
      sell_order_id: sell.id,
      fill_amount_raw: fillAmount.toString(),
      fill_price_raw: fillPrice.toString(),
      settled: !!onChainSig,
      on_chain_sig: onChainSig,
      settled_at: onChainSig ? new Date().toISOString() : null,
    });
    if (matchErr) throw new Error(`dark_matches insert: ${matchErr.message}`);

    await audit('sealed_pool_match', buy.owner_pubkey, {
      match_id: matchId,
      fill_amount: fillAmount.toString(),
      on_chain_sig: onChainSig,
    });
  }

  async listSealedOrders(limit = 20) {
    const { data } = await this.db.from('sealed_orders')
      .select('id, owner_pubkey, commit_hash, margin_raw, guarantee, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }
}
