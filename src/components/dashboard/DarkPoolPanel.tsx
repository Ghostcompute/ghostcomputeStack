import { useEffect, useState } from 'react';
import { Guarantee } from '@ghost-compute/shared';

import { apiUrl } from '../../lib/api.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const GHST_MINT = import.meta.env.VITE_GHST_MINT ?? 'EtSrSMNHkWAxQumXwdKU4KCxc6bAN5fFzsRVdnY3eNz5';

interface OrderbookEntry {
  id: string;
  side: 'buy' | 'sell';
  amount_raw: string;
  price_raw: string;
}

export function DarkPoolPanel() {
  const [bids, setBids] = useState<OrderbookEntry[]>([]);
  const [asks, setAsks] = useState<OrderbookEntry[]>([]);
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [price, setPrice] = useState('');
  const [guarantee, setGuarantee] = useState<Guarantee>(Guarantee.Standard);
  const [submitting, setSubmitting] = useState(false);
  const [walletPubkey, setWalletPubkey] = useState('');

  useEffect(() => {
    const load = () =>
      fetch(`/api/orderbook/${GHST_MINT}/${USDC_MINT}`)
        .then(r => r.json())
        .then(data => {
          setBids(data.bids ?? []);
          setAsks(data.asks ?? []);
        })
        .catch(() => {});

    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, []);

  async function submitOrder() {
    if (!amount || !price || !walletPubkey || submitting) return;
    setSubmitting(true);
    try {
      await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          side,
          base_mint: GHST_MINT,
          quote_mint: USDC_MINT,
          amount: (parseFloat(amount) * 1e9).toFixed(0),
          price: (parseFloat(price) * 1e6).toFixed(0),
          guarantee,
          owner_pubkey: walletPubkey,
        }),
      });
      setAmount('');
      setPrice('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="darkpool-panel">
      <h3>Dark Pool — GHST/USDC</h3>

      <div className="orderbook">
        <div className="orderbook__asks">
          <h4>Asks</h4>
          {asks.map(a => (
            <div key={a.id} className="order-row order-row--ask">
              <span>{(Number(a.price_raw) / 1e6).toFixed(4)}</span>
              <span>{(Number(a.amount_raw) / 1e9).toFixed(2)}</span>
            </div>
          ))}
        </div>
        <div className="orderbook__bids">
          <h4>Bids</h4>
          {bids.map(b => (
            <div key={b.id} className="order-row order-row--bid">
              <span>{(Number(b.price_raw) / 1e6).toFixed(4)}</span>
              <span>{(Number(b.amount_raw) / 1e9).toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="order-form">
        <input placeholder="Wallet pubkey" value={walletPubkey} onChange={e => setWalletPubkey(e.target.value)} />
        <div className="order-form__row">
          <button className={side === 'buy' ? 'active' : ''} onClick={() => setSide('buy')}>Buy</button>
          <button className={side === 'sell' ? 'active' : ''} onClick={() => setSide('sell')}>Sell</button>
        </div>
        <input placeholder="Amount (GHST)" value={amount} onChange={e => setAmount(e.target.value)} />
        <input placeholder="Price (USDC)" value={price} onChange={e => setPrice(e.target.value)} />
        <select value={guarantee} onChange={e => setGuarantee(e.target.value as Guarantee)}>
          <option value={Guarantee.Standard}>Standard</option>
          <option value={Guarantee.High}>High (TEE)</option>
          <option value={Guarantee.MaxTrustSplit}>MaxTrustSplit</option>
        </select>
        <button onClick={submitOrder} disabled={submitting}>
          {submitting ? 'Submitting...' : `Place ${side} order`}
        </button>
      </div>
    </div>
  );
}
