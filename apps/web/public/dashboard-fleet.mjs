/** Live fleet stats for dashboard.html overview + inference panels. */

import { apiUrl } from './dashboard-api.mjs';
import { getDropdown, setDropdownOptions } from './dashboard-dropdown.mjs';

let fleetWorkers = [];
let fleetModelFilter = '';

function formatTps(tps) {
  const n = Number(tps) || 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function formatGhst(raw) {
  const n = BigInt(raw || '0');
  const whole = n / 1_000_000_000n;
  const frac = n % 1_000_000_000n;
  if (whole === 0n) return (Number(n) / 1e9).toFixed(4);
  return `${whole}.${frac.toString().padStart(9, '0').slice(0, 2)}`;
}

function shortPubkey(pk) {
  const s = String(pk || '');
  return s.length > 10 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
}

function shortModel(model) {
  const s = String(model || '');
  if (!s) return '—';
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

function statusTag(status, connected, teeVerified) {
  if (!connected) return '<span class="tag tag-warn">offline</span>';
  if (status === 'busy') return '<span class="tag tag-ok">busy</span>';
  if (teeVerified) return '<span class="tag tag-ok">sealed</span>';
  return '<span class="tag tag-ok">idle</span>';
}

function teeLabel(tee) {
  if (tee === 'nvidia_cc') return 'CC';
  if (tee === 'amd_sev_snp') return 'SEV';
  return 'none';
}

function uniqueModels(workers) {
  const models = new Map();
  for (const w of workers) {
    const id = w.model;
    if (id) models.set(id, shortModel(id));
  }
  return [...models.entries()].sort((a, b) => a[1].localeCompare(b[1]));
}

function filteredWorkers() {
  if (!fleetModelFilter) return fleetWorkers;
  return fleetWorkers.filter(w => w.model === fleetModelFilter);
}

function renderFleetTable() {
  const tbody = document.getElementById('fleetTableBody');
  if (!tbody) return;

  const workers = filteredWorkers();
  if (!fleetWorkers.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-[var(--muted)]">No workers online — start Ghost Worker on your machine</td></tr>';
    return;
  }
  if (!workers.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-[var(--muted)]">No enclaves serving this model</td></tr>';
    return;
  }

  tbody.innerHTML = workers.map(w => `
    <tr>
      <td>${shortPubkey(w.pubkey)}</td>
      <td>${w.model?.split('/').pop()?.slice(0, 12) || 'GPU'} · ${teeLabel(w.tee_type)}</td>
      <td>devnet</td>
      <td>${shortModel(w.model)}</td>
      <td>${Math.round(w.tok_per_sec || 0)} tok/s</td>
      <td>${w.connected ? 'live' : '—'}</td>
      <td>${statusTag(w.status, w.connected, w.attestation_verified)}</td>
    </tr>
  `).join('');
}

function updateModelFilterOptions(workers) {
  const sel = getDropdown('fleetModelFilter');
  if (!sel) return;

  const models = uniqueModels(workers);
  setDropdownOptions(sel, models.map(([value, label]) => ({ value, label })), {
    placeholder: 'All models',
    preserveSelection: true,
  });
  fleetModelFilter = sel.value;
}

function ensureFilterListener() {
  const sel = getDropdown('fleetModelFilter');
  if (!sel || sel.dataset.fleetBound) return;
  sel.dataset.fleetBound = '1';
  sel.addEventListener('change', () => {
    fleetModelFilter = sel.value;
    renderFleetTable();
  });
}

export async function refreshFleetDashboard() {
  let data;
  try {
    const res = await fetch(apiUrl('/api/fleet'));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    console.warn('[fleet] refresh failed:', err);
    return null;
  }

  fleetWorkers = data.workers || [];
  ensureFilterListener();
  updateModelFilterOptions(fleetWorkers);

  const online = data.live?.ws_workers_online ?? fleetWorkers.filter(w => w.connected).length;
  const busy = data.live?.ws_workers_busy ?? fleetWorkers.filter(w => w.status === 'busy').length;
  const utilPct = online > 0 ? Math.round((busy / online) * 100) : 0;

  const elWorkers = document.getElementById('overviewWorkersOnline');
  const elUtil = document.getElementById('overviewUtilization');
  const elUtilBar = document.getElementById('overviewUtilBar');
  const elP50 = document.getElementById('overviewP50');
  const elP99 = document.getElementById('overviewP99Sub');
  const inferTps = document.getElementById('inferTps');
  const inferTtft = document.getElementById('inferTtft');
  const enclaveWorkers = document.getElementById('overviewEnclaveCount');

  if (elWorkers) elWorkers.textContent = String(online);
  if (enclaveWorkers) enclaveWorkers.textContent = String(fleetWorkers.length);
  if (elUtil) elUtil.textContent = utilPct + '%';
  if (elUtilBar) elUtilBar.style.width = utilPct + '%';
  if (elP50) elP50.innerHTML = `${Math.round(data.p50_latency_ms || 0)}<span class="text-[1.2rem] text-[var(--muted)]">ms</span>`;
  if (elP99) elP99.textContent = `p99 ${Math.round(data.p99_latency_ms || 0)}ms`;
  if (inferTps) inferTps.textContent = formatTps(data.avg_tok_per_sec);
  if (inferTtft) inferTtft.textContent = `${Math.round(data.p50_latency_ms || 0)}ms`;

  renderFleetTable();

  return data;
}
