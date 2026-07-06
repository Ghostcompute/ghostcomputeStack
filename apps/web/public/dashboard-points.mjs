/** Points leaderboard for dashboard.html (GHST token tab). */

import { apiUrl } from './dashboard-api.mjs';

function shortPk(pk) {
  const s = String(pk || '');
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
}

function connectedWallet() {
  try {
    const saved = JSON.parse(localStorage.getItem('ghost.wallet') || 'null');
    return saved?.address || null;
  } catch {
    return null;
  }
}

export async function refreshPointsLeaderboard() {
  const tbody = document.getElementById('pointsLeaderboardBody');
  const elTotal = document.getElementById('pointsLeaderCount');
  const elYou = document.getElementById('pointsYourScore');
  if (!tbody) return null;

  let rows;
  try {
    const res = await fetch(apiUrl('/api/points/leaderboard'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    rows = await res.json();
  } catch (err) {
    console.warn('[points] refresh failed:', err);
    tbody.innerHTML = '<tr><td colspan="3" class="text-[var(--muted)]">Leaderboard unavailable</td></tr>';
    return null;
  }

  if (elTotal) elTotal.textContent = String(rows.length);

  const you = connectedWallet();
  const yourRow = you ? rows.find(r => r.pubkey === you) : null;
  if (elYou) elYou.textContent = yourRow ? String(yourRow.total) : you ? '0' : '—';

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="text-[var(--muted)]">No points yet — complete jobs or dark pool matches</td></tr>';
    return rows;
  }

  tbody.innerHTML = rows.slice(0, 15).map((r, i) => {
    const highlight = you && r.pubkey === you ? ' style="background:rgba(255,255,255,.04)"' : '';
    return `<tr${highlight}>
      <td>${i + 1}</td>
      <td class="mono">${shortPk(r.pubkey)}</td>
      <td class="mono">${r.total}</td>
    </tr>`;
  }).join('');

  return rows;
}

export function startPointsPolling() {
  refreshPointsLeaderboard();
  setInterval(refreshPointsLeaderboard, 15000);
}
