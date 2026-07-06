import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchRecentJobs } from "../lib/daemon-api";
import type { DaemonStatus, RecentJob, WorkerStatus } from "../types";
import { Card, CardPad } from "../components/Card";

interface OverviewPanelProps {
  process: DaemonStatus | null;
  worker: WorkerStatus | null;
}

const THROUGHPUT_POINTS = 48;

function fmtNum(val: number | undefined | null, digits = 0): string {
  if (val == null || Number.isNaN(val)) return "—";
  return digits > 0 ? val.toFixed(digits) : String(Math.round(val));
}

function fmtEarn(val: number | undefined | null, withPlus = false): string {
  if (val == null || Number.isNaN(val)) return "0 GHST";
  const amount = val.toFixed(val >= 1 ? 2 : 4);
  return `${withPlus ? "+" : ""}${amount} GHST`;
}

function RingGauge({
  label,
  value,
  display,
}: {
  label: string;
  value: number;
  display: string;
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="dash-ring">
      <div
        className="dash-ring__track"
        style={{
          background: `conic-gradient(#fff ${pct * 3.6}deg, rgba(255,255,255,0.08) 0)`,
        }}
      >
        <div className="dash-ring__inner">
          <span className="dash-ring__value">{display}</span>
          <span className="dash-ring__label">{label}</span>
        </div>
      </div>
    </div>
  );
}

function ThroughputChart({ points }: { points: number[] }) {
  const width = 640;
  const height = 120;
  const pad = 8;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;

  const coords = points.map((v, i) => {
    const x = pad + i * step;
    const y = height - pad - (v / max) * (height - pad * 2);
    return `${x},${y}`;
  });

  const line = coords.length ? coords.join(" ") : `${pad},${height - pad}`;

  return (
    <svg
      className="dash-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function OverviewPanel({ process, worker }: OverviewPanelProps) {
  const [jobs, setJobs] = useState<RecentJob[]>([]);
  const [throughput, setThroughput] = useState<number[]>(
    Array(THROUGHPUT_POINTS).fill(0),
  );

  const gpu = worker?.gpu;
  const util = gpu?.utilization_pct ?? 0;
  const vramUsed = gpu?.vram_used_gb ?? 0;
  const vramTotal = gpu?.vram_gb ?? 0;
  const vramPct = vramTotal > 0 ? (vramUsed / vramTotal) * 100 : 0;
  const powerW = gpu?.power_w ?? 0;
  const powerMax = gpu?.power_max_w ?? 350;
  const powerPct = powerMax > 0 ? (powerW / powerMax) * 100 : 0;

  useEffect(() => {
    const tok = worker?.tokens_per_sec ?? 0;
    setThroughput((prev) => [...prev.slice(1), tok]);
  }, [worker?.tokens_per_sec]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const recent = await fetchRecentJobs();
      if (!cancelled) setJobs(recent.slice(0, 8));
    };
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const gpuTitle = [gpu?.vendor ?? "GPU", gpu?.name ?? "No GPU detected"]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="fade-in dash">
      <Card>
        <CardPad className="dash-gpu">
          <div className="dash-gpu__gauges">
            <RingGauge label="GPU %" value={util} display={`${Math.round(util)}%`} />
            <RingGauge
              label="VRAM"
              value={vramPct}
              display={vramUsed > 0 ? `${Math.round(vramUsed)}G` : "—"}
            />
          </div>
          <div className="dash-gpu__detail">
            <p className="dash-gpu__name">{gpuTitle}</p>
            <div className="dash-bar-row">
              <span className="dash-bar-row__label">VRAM</span>
              <div className="dash-bar">
                <span style={{ width: `${Math.min(100, vramPct)}%` }} />
              </div>
              <span className="dash-bar-row__value">
                {vramTotal > 0
                  ? `${fmtNum(vramUsed, 1)} / ${fmtNum(vramTotal, 0)} GB`
                  : "—"}
              </span>
            </div>
            <div className="dash-bar-row">
              <span className="dash-bar-row__label">POWER</span>
              <div className="dash-bar">
                <span style={{ width: `${Math.min(100, powerPct)}%` }} />
              </div>
              <span className="dash-bar-row__value">
                {powerW > 0 ? `${Math.round(powerW)}W` : "—"}
              </span>
            </div>
            <p className="dash-gpu__meta">
              Temp {gpu?.temperature_c != null ? `${Math.round(gpu.temperature_c)}°C` : "—"}
              {" · "}
              Max {Math.round(powerMax)}W
            </p>
          </div>
        </CardPad>
      </Card>

      <div className="dash-stats">
        <Card>
          <CardPad className="dash-stat">
            <p className="dash-label">Jobs today</p>
            <p className="dash-stat__num">{fmtNum(worker?.jobs_today)}</p>
          </CardPad>
        </Card>
        <Card>
          <CardPad className="dash-stat">
            <p className="dash-label">Tokens / sec</p>
            <p className="dash-stat__num">{fmtNum(worker?.tokens_per_sec)}</p>
          </CardPad>
        </Card>
        <Card>
          <CardPad className="dash-stat">
            <p className="dash-label">Earned today</p>
            <p className="dash-stat__num dash-stat__num--earn">
              {fmtEarn(worker?.earnings_today)}
            </p>
          </CardPad>
        </Card>
      </div>

      <Card>
        <CardPad>
          <p className="dash-label">Throughput</p>
          <ThroughputChart points={throughput} />
        </CardPad>
      </Card>

      <Card>
        <CardPad className="dash-jobs">
          <p className="dash-label">Recent jobs</p>
          {jobs.length === 0 ? (
            <p className="dash-jobs__empty">No completed jobs yet</p>
          ) : (
            <ul className="dash-jobs__list">
              {jobs.map((job) => (
                <li key={job.id} className="dash-jobs__row">
                  <Check size={14} className="dash-jobs__icon" />
                  <span className="dash-jobs__id">#{job.id.slice(0, 8)}</span>
                  <span className="dash-jobs__tokens">
                    {job.tokens != null ? `${job.tokens} tok` : "—"}
                  </span>
                  <span className="dash-jobs__earn">
                    {job.earn != null && job.earn > 0
                      ? fmtEarn(job.earn, true)
                      : job.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardPad>
      </Card>

      {!process?.healthy && process?.error && (
        <p className="dash-footnote">{process.error}</p>
      )}
    </div>
  );
}
