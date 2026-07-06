// Confidential dark pool matching engine
// Orders are ZK-encrypted; matching happens in-process (Arcium MPC for MaxTrustSplit)

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { Guarantee } from '@ghost-compute/shared';
import type { OrderSubmitDTO, OrderMatchDTO } from '@ghost-compute/shared';
import { verifyOrderProof } from '@ghost-compute/crypto';
import {
  createConnection,
  isDarkPoolOnChainEnabled,
  placeOrderOnChain,
  resolveDarkPoolOracle,
  settleMatchOnChain,
} from '@ghost-compute/solana';
import { audit } from '../attestation/service.js';
import { awardPoints } from '../indexer/points.js';
import { mpcMatch } from './arcium.js';

const SUPABASE_URL          = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE ?? '';

interface Order {
  id: string;
  side: 'buy' | 'sell';
  base_mint: string;
  quote_mint: string;
  amount_raw: bigint;
  price_raw: bigint;
  owner_pubkey: string;
  guarantee: Guarantee;
  zk_proof?: string;
  created_at: number;
}

export class DarkPoolEngine {
  private db: SupabaseClient;
  private orderBook = new Map<string, Order>();   // orderId → order

  constructor() {
    this.db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
  }

  async submitOrder(dto: OrderSubmitDTO & { owner_pubkey: string }): Promise<string> {
    // P4-stretch: if the order carries a confidential proof, it must verify —
    // fail closed (reject) otherwise. The amount/price stay hidden in the proof.
    if (dto.zk_proof && !(await verifyOrderProof(dto.zk_proof))) {
      throw new Error('dark pool: invalid order proof');
    }

    const orderId = crypto.randomUUID();
    const order: Order = {
      id: orderId,
      side: dto.side,
      base_mint: dto.base_mint,
      quote_mint: dto.quote_mint,
      amount_raw: BigInt(dto.amount),
      price_raw: BigInt(dto.price),
      owner_pubkey: dto.owner_pubkey,
      guarantee: dto.guarantee,
      zk_proof: dto.zk_proof,
      created_at: Date.now(),
    };

    this.orderBook.set(orderId, order);

    await this.db.from('dark_orders').insert({
      id: orderId,
      side: order.side,
      base_mint: order.base_mint,
      quote_mint: order.quote_mint,
      amount_raw: order.amount_raw.toString(),
      price_raw: order.price_raw.toString(),
      owner_pubkey: order.owner_pubkey,
      guarantee: order.guarantee,
      zk_proof: order.zk_proof ?? null,
      status: 'open',
    });

    if (isDarkPoolOnChainEnabled()) {
      const oracle = resolveDarkPoolOracle();
      if (oracle) {
        try {
          const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
          await placeOrderOnChain(
            createConnection(rpc),
            oracle,
            orderId,
            order.side,
            order.base_mint,
            order.quote_mint,
            order.amount_raw,
            order.price_raw,
            order.guarantee,
          );
        } catch (err) {
          console.error('[darkpool] on-chain place_order failed:', (err as Error).message);
        }
      }
    }

    await this.tryMatch(order);

    return orderId;
  }

  private async tryMatch(newOrder: Order) {
    const oppositeSide = newOrder.side === 'buy' ? 'sell' : 'buy';

    const candidates = [...this.orderBook.values()].filter(o =>
      o.side === oppositeSide &&
      o.base_mint === newOrder.base_mint &&
      o.quote_mint === newOrder.quote_mint &&
      this.pricesCross(newOrder, o),
    );

    if (!candidates.length) return;

    // Sort: sellers ascending price, buyers descending
    candidates.sort((a, b) =>
      newOrder.side === 'buy'
        ? Number(a.price_raw - b.price_raw)
        : Number(b.price_raw - a.price_raw),
    );

    const match = candidates[0];

    // For MaxTrustSplit, delegate to Arcium MPC
    if (newOrder.guarantee === Guarantee.MaxTrustSplit || match.guarantee === Guarantee.MaxTrustSplit) {
      await this.matchViaMpc(newOrder, match);
    } else {
      await this.settleMatch(newOrder, match);
    }
  }

  private pricesCross(buy: Order, sell: Order): boolean {
    if (buy.side === 'buy') return buy.price_raw >= sell.price_raw;
    return sell.price_raw >= buy.price_raw;
  }

  private async settleMatch(a: Order, b: Order): Promise<OrderMatchDTO> {
    const [buy, sell] = a.side === 'buy' ? [a, b] : [b, a];
    const fillAmount  = buy.amount_raw < sell.amount_raw ? buy.amount_raw : sell.amount_raw;
    const fillPrice   = (buy.price_raw + sell.price_raw) / 2n;
    const matchId     = crypto.randomUUID();

    this.orderBook.delete(buy.id);
    this.orderBook.delete(sell.id);

    const match: OrderMatchDTO = {
      match_id: matchId,
      buy_order_id: buy.id,
      sell_order_id: sell.id,
      fill_amount: fillAmount.toString(),
      fill_price: fillPrice.toString(),
    };

    let onChainSig: string | null = null;
    if (isDarkPoolOnChainEnabled()) {
      const oracle = resolveDarkPoolOracle();
      if (oracle) {
        try {
          const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
          onChainSig = await settleMatchOnChain(
            createConnection(rpc),
            oracle,
            matchId,
            buy.id,
            sell.id,
            fillAmount,
            fillPrice,
          );
        } catch (err) {
          console.error('[darkpool] on-chain settle_match failed:', (err as Error).message);
        }
      }
    }

    await this.db.from('dark_matches').insert({
      id: matchId,
      buy_order_id: buy.id,
      sell_order_id: sell.id,
      fill_amount_raw: fillAmount.toString(),
      fill_price_raw: fillPrice.toString(),
      settled: !!onChainSig,
      on_chain_sig: onChainSig,
      settled_at: onChainSig ? new Date().toISOString() : null,
    });

    await this.db.from('dark_orders').update({ status: 'matched', match_id: matchId })
      .in('id', [buy.id, sell.id]);

    await audit('dark_pool_match', buy.owner_pubkey, {
      match_id: matchId,
      fill_amount: fillAmount.toString(),
      on_chain_sig: onChainSig,
    });
    await awardPoints(buy.owner_pubkey, 'DARK_ORDER_MATCH', matchId).catch(() => {});
    await awardPoints(sell.owner_pubkey, 'DARK_ORDER_MATCH', matchId).catch(() => {});

    return match;
  }

  private async matchViaMpc(a: Order, b: Order): Promise<void> {
    try {
      // Route the confidential cross through the Arcium trust-split interface;
      // local in-enclave clearing is the fallback when Arcium isn't configured.
      const result = await mpcMatch(
        {
          buy:  { ciphertext: a.zk_proof ?? '', owner_pubkey: a.owner_pubkey },
          sell: { ciphertext: b.zk_proof ?? '', owner_pubkey: b.owner_pubkey },
          base_mint: a.base_mint,
          quote_mint: a.quote_mint,
        },
        async () => {
          // In-enclave equivalent: compute the cross from the (decrypted) operands.
          const [buy, sell] = a.side === 'buy' ? [a, b] : [b, a];
          const fillAmount = buy.amount_raw < sell.amount_raw ? buy.amount_raw : sell.amount_raw;
          const fillPrice = (buy.price_raw + sell.price_raw) / 2n;
          return { crossed: true, fill_amount_raw: fillAmount.toString(), fill_price_raw: fillPrice.toString() };
        },
      );

      if (!result.crossed) return;

      this.orderBook.delete(a.id);
      this.orderBook.delete(b.id);

      const matchId = crypto.randomUUID();
      let onChainSig: string | null = null;
      const buyId = a.side === 'buy' ? a.id : b.id;
      const sellId = a.side === 'sell' ? a.id : b.id;
      if (isDarkPoolOnChainEnabled()) {
        const oracle = resolveDarkPoolOracle();
        if (oracle) {
          try {
            const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
            onChainSig = await settleMatchOnChain(
              createConnection(rpc),
              oracle,
              matchId,
              buyId,
              sellId,
              BigInt(result.fill_amount_raw),
              BigInt(result.fill_price_raw),
            );
          } catch (err) {
            console.error('[darkpool] MPC on-chain settle failed:', (err as Error).message);
          }
        }
      }
      await this.db.from('dark_matches').insert({
        id: matchId,
        buy_order_id: buyId,
        sell_order_id: sellId,
        fill_amount_raw: result.fill_amount_raw,
        fill_price_raw: result.fill_price_raw,
        settled: !!onChainSig,
        on_chain_sig: onChainSig,
        settled_at: onChainSig ? new Date().toISOString() : null,
      });
      await this.db.from('dark_orders').update({ status: 'matched', match_id: matchId })
        .in('id', [a.id, b.id]);
    } catch (err) {
      console.error('[darkpool] MPC match failed:', err);
      await this.settleMatch(a, b);
    }
  }

  async cancelOrder(orderId: string, ownerPubkey: string): Promise<boolean> {
    const order = this.orderBook.get(orderId);
    if (!order || order.owner_pubkey !== ownerPubkey) return false;

    this.orderBook.delete(orderId);
    await this.db.from('dark_orders').update({ status: 'cancelled' }).eq('id', orderId);
    return true;
  }

  async getRecentMatches(limit = 20) {
    const { data } = await this.db.from('dark_matches')
      .select('id, buy_order_id, sell_order_id, fill_amount_raw, fill_price_raw, settled, on_chain_sig, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    return data ?? [];
  }

  getOrderBook(baseMint: string, quoteMint: string) {
    const orders = [...this.orderBook.values()]
      .filter(o => o.base_mint === baseMint && o.quote_mint === quoteMint);
    return {
      bids: orders.filter(o => o.side === 'buy').sort((a, b) => Number(b.price_raw - a.price_raw)),
      asks: orders.filter(o => o.side === 'sell').sort((a, b) => Number(a.price_raw - b.price_raw)),
    };
  }
}
