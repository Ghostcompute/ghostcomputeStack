import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { APP_NAME, APP_VERSION, HELP_LINKS } from "../lib/app-meta";
import { truncateAddress } from "../lib/operator-address";
import type { DaemonStatus, WorkerStatus } from "../types";
import { Card, CardPad } from "../components/Card";

interface AboutPanelProps {
  worker: WorkerStatus | null;
  process: DaemonStatus | null;
  operatorAddress?: string | null;
  onOpenWalletModal: () => void;
}

function inferenceLabel(worker: WorkerStatus | null): string {
  if (worker?.inference_ready) return "Ready";
  if (worker?.ollama_status === "running" && worker.ollama_message) {
    return worker.ollama_message;
  }
  if (worker?.inference_error) return worker.inference_error;
  if (worker?.ollama_message) return worker.ollama_message;
  return "Setting up…";
}

function buildDiagnostics(
  worker: WorkerStatus | null,
  process: DaemonStatus | null,
  operatorAddress?: string | null,
): string {
  const lines = [
    `${APP_NAME} ${APP_VERSION}`,
    `platform: ${navigator.platform}`,
    `userAgent: ${navigator.userAgent}`,
    `daemon: ${process?.healthy ? "healthy" : process?.error ?? "offline"}`,
    `daemon_mode: ${process?.mode ?? "—"}`,
    `worker_running: ${worker?.running ?? false}`,
    `payout_wallet: ${operatorAddress ?? "not set"}`,
    `active_model: ${worker?.active_model ?? worker?.selected_model ?? "—"}`,
    `inference: ${inferenceLabel(worker)}`,
    `inference_backend: ${worker?.inference_backend ?? "—"}`,
    `gpu: ${worker?.gpu?.name ?? "none"}`,
    `ollama_status: ${worker?.ollama_status ?? "—"}`,
  ];
  if (worker?.inference_error) lines.push(`inference_error: ${worker.inference_error}`);
  if (worker?.last_backend_error) lines.push(`orchestrator_error: ${worker.last_backend_error}`);
  return lines.join("\n");
}

export function AboutPanel({
  worker,
  process,
  operatorAddress,
  onOpenWalletModal,
}: AboutPanelProps) {
  const [copied, setCopied] = useState(false);

  async function copyDiagnostics() {
    const text = buildDiagnostics(worker, process, operatorAddress);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="fade-in stack mt-3">
      <Card>
        <CardPad>
          <p className="kicker">// about</p>
          <h3 className="panel-title">{APP_NAME}</h3>
          <p className="panel-desc">
            Turn your GPU into a Ghost Compute worker node. Run inference locally, register
            on the network, and earn GHST credits to your payout wallet.
          </p>
          <p className="about-version mt-3">
            Version <span className="mono">{APP_VERSION}</span>
          </p>
        </CardPad>
      </Card>

      <Card>
        <CardPad>
          <p className="kicker">// your node</p>
          <h3 className="panel-title">Current setup</h3>
          <table className="q mt-3">
            <tbody>
              <tr>
                <td>Payout wallet</td>
                <td>
                  {operatorAddress ? (
                    truncateAddress(operatorAddress, 8, 8)
                  ) : (
                    <button type="button" className="about-link-btn" onClick={onOpenWalletModal}>
                      Not set — add wallet
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <td>Active model</td>
                <td>{worker?.active_model ?? worker?.selected_model ?? "—"}</td>
              </tr>
              <tr>
                <td>Inference</td>
                <td>{inferenceLabel(worker)}</td>
              </tr>
              <tr>
                <td>Worker</td>
                <td>{worker?.running ? "Running on network" : "Stopped"}</td>
              </tr>
              <tr>
                <td>Daemon</td>
                <td>{process?.healthy ? "Connected" : process?.error ?? "Offline"}</td>
              </tr>
            </tbody>
          </table>
        </CardPad>
      </Card>

      <Card>
        <CardPad>
          <p className="kicker">// help</p>
          <h3 className="panel-title">Get help</h3>
          <ul className="about-links mt-3">
            {HELP_LINKS.map(({ label, href }) => (
              <li key={label}>
                <a href={href} target="_blank" rel="noopener noreferrer" className="about-link">
                  <span>{label}</span>
                  <ExternalLink size={14} strokeWidth={2} />
                </a>
              </li>
            ))}
          </ul>
          <p className="panel-desc mt-4">
            Set your payout wallet from the top bar before starting the worker. Choose and
            download models from the Models tab.
          </p>
        </CardPad>
      </Card>

      <Card>
        <CardPad>
          <details className="about-details">
            <summary className="about-details__summary">
              <span className="kicker">// diagnostics</span>
              <span className="panel-title">Support info</span>
            </summary>
            <p className="panel-desc mt-3">
              Copy this report when contacting support. It includes app version, hardware,
              and worker status — no private keys.
            </p>
            <pre className="about-diagnostics mt-3">{buildDiagnostics(worker, process, operatorAddress)}</pre>
            <button type="button" className="chip mt-3" onClick={() => void copyDiagnostics()}>
              <Copy size={12} />
              {copied ? "Copied" : "Copy support info"}
            </button>
          </details>
        </CardPad>
      </Card>
    </div>
  );
}
