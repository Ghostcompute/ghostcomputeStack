import type { WorkerStatus } from "../types";
import { Card, CardPad, Tag } from "../components/Card";

export function HardwarePanel({ worker }: { worker: WorkerStatus | null }) {
  const gpu = worker?.gpu;
  const vramPct =
    gpu?.vram_gb && gpu.vram_used_gb != null
      ? Math.min(100, Math.round((gpu.vram_used_gb / gpu.vram_gb) * 100))
      : gpu?.utilization_pct ?? 0;

  return (
    <div className="fade-in stack">
      <div className="grid-3 mt-3">
        <Card>
          <CardPad>
            <p className="kicker">// gpu</p>
            <div className="metric-num mt-3" style={{ fontSize: "1.4rem" }}>
              {gpu?.name ?? "—"}
            </div>
            <p className="kicker mt-3">
              {worker?.gpu_detected ? "detected" : "not detected"}
            </p>
          </CardPad>
        </Card>
        <Card>
          <CardPad>
            <p className="kicker">// vram</p>
            <div className="metric-num mt-3">
              {gpu?.vram_used_gb != null && gpu?.vram_gb != null
                ? `${gpu.vram_used_gb} / ${gpu.vram_gb} GB`
                : gpu?.vram_gb != null
                  ? `${gpu.vram_gb} GB`
                  : "—"}
            </div>
            <div className="bar mt-4">
              <span style={{ width: `${vramPct}%` }} />
            </div>
          </CardPad>
        </Card>
        <Card>
          <CardPad>
            <p className="kicker">// tee</p>
            <div className="metric-num mt-3" style={{ fontSize: "1.6rem" }}>
              {worker?.tee_type ?? "none"}
            </div>
            <p className="kicker mt-3">
              {worker?.tee_capable ? "hardware attestation ready" : "software mode"}
            </p>
          </CardPad>
        </Card>
      </div>

      <Card>
        <CardPad>
          <div className="row-between">
            <div>
              <p className="kicker">// capability probe</p>
              <h3 className="panel-title">Hardware profile</h3>
            </div>
            <Tag variant={worker?.gpu_detected ? "ok" : "warn"}>
              {worker?.effective_compute ?? worker?.compute_mode ?? "auto"}
            </Tag>
          </div>
          <table className="q mt-4">
            <thead>
              <tr>
                <th>Property</th>
                <th>Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>GPU</td>
                <td>{gpu?.name ?? "—"}</td>
                <td>
                  <Tag variant={worker?.gpu_detected ? "ok" : "warn"}>
                    {worker?.gpu_detected ? "ok" : "missing"}
                  </Tag>
                </td>
              </tr>
              <tr>
                <td>PCI slot</td>
                <td>{gpu?.pci_slot ?? "—"}</td>
                <td><Tag>{gpu?.driver ?? "—"}</Tag></td>
              </tr>
              <tr>
                <td>Utilization</td>
                <td>{gpu?.utilization_pct != null ? `${gpu.utilization_pct}%` : "—"}</td>
                <td><Tag>live</Tag></td>
              </tr>
              <tr>
                <td>Temperature</td>
                <td>{gpu?.temperature_c != null ? `${gpu.temperature_c}°C` : "—"}</td>
                <td><Tag>sensor</Tag></td>
              </tr>
              <tr>
                <td>Compute mode</td>
                <td>{worker?.compute_mode ?? "—"}</td>
                <td><Tag variant="ok">{worker?.effective_compute ?? "—"}</Tag></td>
              </tr>
            </tbody>
          </table>
        </CardPad>
      </Card>
    </div>
  );
}
