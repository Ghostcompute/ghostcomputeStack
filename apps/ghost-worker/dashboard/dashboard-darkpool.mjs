/** Live dark pool orderbook, order submission, and match log for dashboard.html */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
let ghstMint = 'EtSrSMNHkWAxQumXwdKU4KCxc6bAN5fFzsRVdnY3eNz5';
let currentSide = 'buy';

function shortPk(pk) {
  const s = String(pk || '');
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
}

function shortSig(sig) {
  const s = String(sig || '');
  return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s || '—';
}

function formatGhst(raw) {
  return (Number(raw || 0) / 1e9).toFixed(4);
}

function formatUsdc(raw) {
  return (Number(raw || 0) / 1e6).toFixed(4);
}

function walletAddress() {
  try {
    const saved = JSON.parse(localStorage.getItem('ghost.wallet') || 'null');
    return saved?.address || null;
  } catch {
    return null;
  }
}

export function setDarkPoolSide(side) {
  currentSide = side === 'sell' ? 'sell' : 'buy';
}

export async function resolveGhstMint() {
  try {
    const res = await fetch('/api/x402/config');
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.ghstMint) ghstMint = cfg.ghstMint;
    }
  } catch { /* use default */ }
  return ghstMint;
}

async function fetchOrderbook() {
  const base = await resolveGhstMint();
  const res = await fetch(`/api/orderbook/${base}/${USDC_MINT}`);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function fetchMatches() {
  const res = await fetch('/api/darkpool/matches');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function renderOrderRows(container, rows, side) {
  if (!container) return;
  if (!rows?.length) {
    container.innerHTML = `<p class="text-sm text-[var(--muted)]">No ${side}s</p>`;
    return;
  }
  container.innerHTML = rows.slice(0, 8).map(o => `
    <div class="flex justify-between text-sm mono py-1 border-b border-[var(--line)] last:border-0">
      <span>${formatUsdc(o.price_raw)} USDC</span>
      <span>${formatGhst(o.amount_raw)} GHST</span>
    </div>
  `).join('');
}

export async function refreshDarkPoolDashboard() {
  let book;
  let matches;
  try {
    [book, matches] = await Promise.all([fetchOrderbook(), fetchMatches()]);
  } catch (err) {
    console.warn('[darkpool] refresh failed:', err);
    return null;
  }

  const bids = book.bids || [];
  const asks = book.asks || [];
  const settled = matches.filter(m => m.settled);
  const totalFillRaw = matches.reduce((s, m) => s + BigInt(m.fill_amount_raw || '0'), 0n);

  const elMatches = document.getElementById('darkpoolMatchCount');
  const elOpen = document.getElementById('darkpoolOpenOrders');
  const elVolume = document.getElementById('darkpoolVolumeGhst');
  const elSettled = document.getElementById('darkpoolSettledCount');
  const elAsks = document.getElementById('darkpoolAsks');
  const elBids = document.getElementById('darkpoolBids');
  const elPair = document.getElementById('darkpoolPairLabel');
  const tbody = document.getElementById('darkpoolMatchesBody');

  if (elMatches) elMatches.textContent = String(matches.length);
  if (elOpen) elOpen.textContent = String(bids.length + asks.length);
  if (elVolume) elVolume.textContent = formatGhst(totalFillRaw.toString());
  if (elSettled) elSettled.textContent = String(settled.length);
  if (elPair) elPair.textContent = 'GHST / USDC';

  renderOrderRows(elAsks, asks, 'ask');
  renderOrderRows(elBids, bids, 'bid');

  if (tbody) {
    if (!matches.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-[var(--muted)]">No matches yet — place crossing buy/sell orders</td></tr>';
    } else {
      tbody.innerHTML = matches.slice(0, 12).map(m => {
        const ts = m.created_at ? new Date(m.created_at).toISOString().substr(11, 8) : '—';
        const tx = m.on_chain_sig
          ? `<a class="link" href="https://solscan.io/tx/${m.on_chain_sig}?cluster=devnet" target="_blank" rel="noopener">${shortSig(m.on_chain_sig)}</a>`
          : '—';
        const tag = m.settled
          ? '<span class="tag tag-ok">settled</span>'
          : '<span class="tag tag-warn">pending</span>';
        return `<tr>
          <td>${ts}</td>
          <td>GHST/USDC</td>
          <td>match</td>
          <td>${formatGhst(m.fill_amount_raw)} GHST</td>
          <td>${formatUsdc(m.fill_price_raw)} USDC</td>
          <td>${tx} ${tag}</td>
        </tr>`;
      }).join('');
    }
  }

  return { book, matches };
}

export async function submitDarkPoolOrder() {
  const owner = walletAddress();
  if (!owner) {
    window.openWalletModal?.();
    throw new Error('Connect wallet first');
  }

  const amountEl = document.getElementById('darkpoolAmount');
  const priceEl = document.getElementById('darkpoolPrice');
  const guaranteeEl = document.getElementById('darkpoolGuarantee');
  const amount = parseFloat(amountEl?.value || '0');
  const price = parseFloat(priceEl?.value || '0');
  const guarantee = guaranteeEl?.value || 'standard';

  if (!amount || !price) throw new Error('Enter amount and price');

  const base = await resolveGhstMint();
  const res = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      side: currentSide,
      base_mint: base,
      quote_mint: USDC_MINT,
      amount: Math.round(amount * 1e9).toString(),
      price: Math.round(price * 1e6).toString(),
      guarantee,
      owner_pubkey: owner,
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Order failed');

  if (amountEl) amountEl.value = '';
  if (priceEl) priceEl.value = '';
  const encEl = document.getElementById('encSize');
  if (encEl) encEl.textContent = `order ${String(body.order_id || '').slice(0, 8)}… submitted`;

  await refreshDarkPoolDashboard();
  window.toast?.(`${currentSide.toUpperCase()} order submitted`);
  return body;
}

export async function submitSealedDarkPoolOrder() {
  const owner = walletAddress();
  if (!owner) {
    window.openWalletModal?.();
    throw new Error('Connect wallet first');
  }

  const amountEl = document.getElementById('darkpoolAmount');
  const priceEl = document.getElementById('darkpoolPrice');
  const amount = parseFloat(amountEl?.value || '0');
  const price = parseFloat(priceEl?.value || '0');
  if (!amount || !price) throw new Error('Enter amount and price');

  const amountRaw = Math.round(amount * 1e9).toString();
  const priceRaw = Math.round(price * 1e6).toString();
  const ciphertext = Buffer.from(JSON.stringify({
    side: currentSide,
    amount_raw: amountRaw,
    price_raw: priceRaw,
  })).toString('base64');

  const res = await fetch('/api/orders/sealed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_pubkey: owner,
      ciphertext,
      margin: amountRaw,
      guarantee: 'high',
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Sealed order failed');

  const encEl = document.getElementById('encSize');
  if (encEl) encEl.textContent = `sealed ${String(body.order_id || '').slice(0, 8)}… · commit ok`;

  await refreshDarkPoolDashboard();
  window.toast?.(`Sealed ${currentSide.toUpperCase()} order submitted`);
  return body;
}

export function startDarkPoolPolling() {
  refreshDarkPoolDashboard();
  setInterval(refreshDarkPoolDashboard, 6000);
}
