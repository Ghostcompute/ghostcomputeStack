import { useEffect, useState } from 'react';

interface WorkerJob {
  id: string;
  status: string;
  tokens: number;
  guarantee: string;
  earn: number;
  duration_ms: number;
  ttft_ms?: number;
  tpot_ms?: number;
  sla_met?: boolean;
  penalty_paid?: number;
}

interface WorkerStats {
  worker_address: string;
  hardware_tier: string;
  status: string;
  tee_type: string;
  tee_capable: boolean;
  jobs_today: number;
  earnings_today: number;
  penalties_paid: number;
  sla_pass_rate: number;
  p99_ttft_ms: number;
  goodput_score: number;
  reliability_score: number;
  ws_online: boolean;
  ws_tok_per_sec: number;
}

const DAEMON_URL = 'http://127.0.0.1:7421';

export function WorkerPanel() {
  const [status, setStatus] = useState<WorkerStats | null>(null);
  const [jobs, setJobs] = useState<WorkerJob[]>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [daemonOnline, setDaemonOnline] = useState(false);

  // Poll local daemon for live stats
  useEffect(() => {
    async function poll() {
      try {
        const [sRes, jRes] = await Promise.all([
          fetch(`${DAEMON_URL}/status`),
          fetch(`${DAEMON_URL}/jobs`),
        ]);
        if (sRes.ok) {
          const s = await sRes.json();
          setStatus(s);
          setRunning(s.running ?? false);
          setDaemonOnline(true);
        }
        if (jRes.ok) {
          const j = await jRes.json();
          setJobs(j.jobs ?? []);
        }
      } catch {
        setDaemonOnline(false);
      }
    }

    poll();
    const id = setInterval(poll, 3_000);
    return () => clearInterval(id);
  }, []);

  async function toggleWorker() {
    if (busy) return;
    setBusy(true);
    try {
      const path = running ? '/worker/stop' : '/worker/start';
      const res = await fetch(`${DAEMON_URL}${path}`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) setRunning(!running);
      else alert(data.message ?? data.error ?? 'Failed');
    } catch (e: any) {
      alert(`Daemon unreachable: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const slaColor = !status ? '#888' :
    status.sla_pass_rate >= 99 ? '#22cc66' :
    status.sla_pass_rate >= 97 ? '#ffaa00' : '#ff4444';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header + toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h3 style={{ margin: 0 }}>GPU Worker</h3>
          {status && (
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              {status.hardware_tier}
              {status.tee_capable && (
                <span style={{ marginLeft: 8, color: '#a855f7', fontWeight: 700 }}>
                  TEE:{status.tee_type.toUpperCase()}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={toggleWorker}
          disabled={busy || !daemonOnline}
          style={{
            padding: '8px 20px', borderRadius: 6, border: 'none', cursor: 'pointer',
            fontWeight: 700, fontSize: 13,
            background: running ? '#222' : '#22cc66',
            color: running ? '#888' : '#000',
            opacity: daemonOnline ? 1 : 0.5,
          }}
        >
          {busy ? '…' : running ? 'Pause' : 'Start'}
        </button>
      </div>

      {!daemonOnline && (
        <div style={{ padding: '12px 16px', borderRadius: 6, background: 'rgba(255,170,0,0.08)',
          border: '1px solid rgba(255,170,0,0.3)', fontSize: 12, color: '#ffaa00' }}>
          Daemon offline — run <code>python worker/python/daemon.py</code> on your GPU machine.
        </div>
      )}

      {/* KPI grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: 'Jobs Today',    value: status ? String(status.jobs_today) : '—' },
          { label: 'Earned (GHST)', value: status ? status.earnings_today.toFixed(4) : '—' },
          { label: 'SLA Pass Rate', value: status ? `${status.sla_pass_rate.toFixed(1)}%` : '—', color: slaColor },
          { label: 'P99 TTFT',      value: status ? `${status.p99_ttft_ms}ms` : '—' },
          { label: 'Goodput Score', value: status ? String(status.goodput_score) : '—' },
          { label: 'Reliability',   value: status ? `${status.reliability_score}/10k` : '—' },
          { label: 'Tok/s',         value: status ? `${status.ws_tok_per_sec}` : '—' },
          { label: 'Penalties',     value: status ? status.penalties_paid.toFixed(4) : '—', color: status?.penalties_paid ? '#ff4444' : undefined },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: '#111', borderRadius: 6, padding: 10,
            border: '1px solid #222' }}>
            <div style={{ fontSize: 10, color: '#555', fontWeight: 700, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: color ?? '#fff' }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Job history */}
      <div>
        <div style={{ fontSize: 11, color: '#555', fontWeight: 700, marginBottom: 8 }}>JOB HISTORY</div>
        {jobs.length === 0 ? (
          <div style={{ fontSize: 12, color: '#555', padding: '16px 0' }}>No jobs yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#555', fontWeight: 700 }}>
                {['ID', 'Status', 'Guarantee', 'Tokens', 'Earn (GHST)', 'Duration'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid #222' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {jobs.map(j => (
                <tr key={j.id} style={{ borderBottom: '1px solid #111' }}>
                  <td style={{ padding: '4px 8px', fontFamily: 'monospace', color: '#555' }}>
                    {j.id?.slice(0, 8) ?? '—'}
                  </td>
                  <td style={{ padding: '4px 8px', color: j.status === 'completed' ? '#22cc66' : '#ff4444', fontWeight: 700 }}>
                    {j.status}
                  </td>
                  <td style={{ padding: '4px 8px', color: j.guarantee === 'max_trust_split' ? '#a855f7' : j.guarantee === 'high' ? '#60a5fa' : '#888' }}>
                    {j.guarantee ?? 'standard'}
                  </td>
                  <td style={{ padding: '4px 8px' }}>{j.tokens}</td>
                  <td style={{ padding: '4px 8px', color: '#ffaa00' }}>{j.earn?.toFixed(4)}</td>
                  <td style={{ padding: '4px 8px', color: '#555' }}>{j.duration_ms}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
