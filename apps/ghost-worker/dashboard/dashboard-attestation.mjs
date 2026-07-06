/** Live attestation feed + attestation table for dashboard.html */

function tsShort(iso) {
  if (!iso) return '--:--:--';
  try {
    return new Date(iso).toISOString().substr(11, 8);
  } catch {
    return '--:--:--';
  }
}

function appendFeedLine(feed, kind, message, ts) {
  if (!feed) return;
  const div = document.createElement('div');
  div.innerHTML = `<span class="dim">[${tsShort(ts)}]</span> <span class="prompt">${kind.padEnd(5, ' ')}</span> ${message}`;
  feed.insertBefore(div, feed.firstChild);
  while (feed.children.length > 12) feed.removeChild(feed.lastChild);
}

export async function refreshLiveFeed() {
  const feed = document.getElementById('liveFeed');
  if (!feed) return null;
  try {
    const res = await fetch('/api/explorer/feed');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = await res.json();
    if (!Array.isArray(items) || !items.length) return items;
    feed.innerHTML = '';
    for (const item of items.slice(0, 12)) {
      appendFeedLine(feed, item.kind || 'event', item.message || '', item.ts);
    }
    return items;
  } catch (err) {
    console.warn('[attestation] feed refresh failed:', err);
    return null;
  }
}

function verdictTag(verdict) {
  const ok = verdict === 'ok' || verdict === 'verified';
  return ok
    ? '<span class="tag tag-ok">ok</span>'
    : '<span class="tag tag-warn">' + String(verdict || 'pending') + '</span>';
}

export async function refreshAttestationTable() {
  const tbody = document.getElementById('attestTableBody');
  if (!tbody) return null;
  try {
    const res = await fetch('/api/explorer/attestations');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-[var(--muted)]">No attestations yet</td></tr>';
      return rows;
    }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${r.slot != null ? Number(r.slot).toLocaleString() : '—'}</td>
        <td>${r.worker || '—'}</td>
        <td>attest</td>
        <td>${r.quote_fp || '—'}</td>
        <td>${r.tx_fp || '—'}</td>
        <td>${verdictTag(r.verdict)}</td>
      </tr>
    `).join('');
    return rows;
  } catch (err) {
    console.warn('[attestation] table refresh failed:', err);
    return null;
  }
}

export function startAttestationPolling() {
  refreshLiveFeed();
  refreshAttestationTable();
  setInterval(refreshLiveFeed, 4000);
  setInterval(refreshAttestationTable, 12000);
}
