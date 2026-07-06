import { useEffect, useState } from 'react';
import type { FleetStatsDTO } from '@ghost-compute/shared';
import { apiUrl } from '../../lib/api.js';

interface LiveWorker {
  id: string;
  pubkey: string;
  model: string;
  tok_per_sec: number;
  tee_type: string;
  attestation_verified: boolean;
  status: string;
  jobs_completed: number;
  connected: boolean;
  last_seen_ms: number;
}

interface FleetResponse extends FleetStatsDTO {
  live?: {
    ws_workers_online: number;
    ws_workers_busy: number;
    jobs_in_queue: number;
    jobs_in_flight: number;
  };
  workers?: LiveWorker[];
}

export function FleetCard() {
  const [data, setData] = useState<FleetResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetch(apiUrl('/api/fleet'))
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((json) => { setData(json); setError(null); })
        .catch((e) => setError(e.message ?? 'Failed to load fleet'));
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, []);

  if (error) {
    return (
      <div className="fleet-card">
        <h3>GPU Fleet</h3>
        <p style={{ color: '#ff6666', fontSize: 13 }}>
          Cannot reach orchestrator — run <code>pnpm orchestrator</code> ({error})
        </p>
      </div>
    );
  }

  if (!data) return <div className="fleet-card loading">Loading fleet...</div>;

  const workers = data.workers ?? [];

  return (
    <div className="fleet-card">
      <h3>GPU Fleet</h3>
      <div className="fleet-grid">
        <Stat label="WS Online" value={data.live?.ws_workers_online ?? data.active_workers} />
        <Stat label="Busy" value={data.live?.ws_workers_busy ?? 0} />
        <Stat label="Jobs (24h)" value={data.total_jobs_24h} />
        <Stat label="In Flight" value={data.live?.jobs_in_flight ?? 0} />
        <Stat label="Avg tok/s" value={data.avg_tok_per_sec.toFixed(1)} />
        <Stat label="P50 latency" value={`${data.p50_latency_ms}ms`} />
        <Stat label="P99 latency" value={`${data.p99_latency_ms}ms`} />
        <Stat label="GHST paid (24h)" value={formatGhst(data.total_ghst_paid_24h)} />
      </div>

      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 11, color: '#555', fontWeight: 700, marginBottom: 8 }}>
          LIVE WORKERS ({workers.length})
        </div>
        {workers.length === 0 ? (
          <p style={{ fontSize: 13, color: '#666' }}>
            No workers connected — start <strong>Ghost Worker</strong> on your machine (Ollama runs locally on your PC).
          </p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#555', fontWeight: 700 }}>
                {['Worker', 'Model', 'tok/s', 'TEE', 'Status', 'Jobs', 'Link'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #222' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {workers.map(w => (
                <tr key={w.id} style={{ borderBottom: '1px solid #111' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', color: '#888' }}>
                    {w.pubkey.slice(0, 8)}…
                  </td>
                  <td style={{ padding: '6px 8px' }}>{shortModel(w.model)}</td>
                  <td style={{ padding: '6px 8px' }}>{w.tok_per_sec.toFixed(1)}</td>
                  <td style={{ padding: '6px 8px', color: w.tee_type !== 'none' ? '#a855f7' : '#555' }}>
                    {w.tee_type}
                  </td>
                  <td style={{ padding: '6px 8px', color: statusColor(w.status), fontWeight: 700 }}>
                    {w.status}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{w.jobs_completed}</td>
                  <td style={{ padding: '6px 8px', color: w.connected ? '#22cc66' : '#ff4444' }}>
                    {w.connected ? 'online' : 'offline'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="fleet-stat">
      <span className="fleet-stat__label">{label}</span>
      <span className="fleet-stat__value">{value}</span>
    </div>
  );
}

function formatGhst(raw: string): string {
  const n = BigInt(raw);
  const ghst = Number(n) / 1e9;
  return `${ghst.toFixed(4)} GHST`;
}

function shortModel(model: string): string {
  const parts = model.split('/');
  return parts[parts.length - 1] ?? model;
}

function statusColor(status: string): string {
  if (status === 'busy') return '#ffaa00';
  if (status === 'idle') return '#22cc66';
  if (status === 'autogated') return '#ff6644';
  return '#888';
}
