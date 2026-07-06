import { ChevronDown, Loader2, RefreshCcw, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clearOperatorWallet } from "../lib/daemon-api";
import { workerStart, workerStop } from "../hooks/useDaemon";
import {
  addressAvatarLabel,
  clearStoredOperatorAddress,
  truncateAddress,
} from "../lib/operator-address";
import type { WorkerStatus } from "../types";
import { OperatorAddressModal } from "./OperatorAddressModal";

interface TopbarProps {
  onRefresh: () => void;
  daemonOnline: boolean;
  onRestartDaemon: () => void;
  operatorAddress?: string | null;
  onOperatorAddressSaved: () => void;
  walletModalOpen: boolean;
  onWalletModalOpenChange: (open: boolean) => void;
  worker: WorkerStatus | null;
  onWorkerRefresh: () => Promise<unknown>;
}

export function Topbar({
  onRefresh,
  daemonOnline,
  onRestartDaemon,
  operatorAddress,
  onOperatorAddressSaved,
  walletModalOpen,
  onWalletModalOpenChange,
  worker,
  onWorkerRefresh,
}: TopbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [workerBusy, setWorkerBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasAddress = Boolean(operatorAddress?.trim());
  const running = worker?.running;
  const activeJob = worker?.active_job;
  const connected = worker?.backend_ok;

  const statusLabel = running ? (activeJob ? "BUSY" : "RUNNING") : "IDLE";
  const statusParts = [
    statusLabel,
    connected ? "Ghost connected" : "Offline",
    worker?.inference_backend ?? "ollama",
    worker?.effective_compute ?? (worker?.gpu_detected ? "GPU" : "CPU"),
  ];

  useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [menuOpen]);

  async function disconnect() {
    setMenuOpen(false);
    clearStoredOperatorAddress();
    await clearOperatorWallet();
    onOperatorAddressSaved();
  }

  async function copyAddress() {
    if (!operatorAddress) return;
    try {
      await navigator.clipboard.writeText(operatorAddress);
    } catch {
      /* ignore */
    }
    setMenuOpen(false);
  }

  async function toggleWorker() {
    if (!hasAddress && !running) {
      onWalletModalOpenChange(true);
      return;
    }
    setWorkerBusy(true);
    const result = running ? await workerStop() : await workerStart();
    if (result.ok && !running) {
      for (let i = 0; i < 15; i++) {
        const latest = (await onWorkerRefresh()) as { worker?: WorkerStatus | null } | undefined;
        if (latest?.worker?.running) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    } else {
      await onWorkerRefresh();
    }
    setWorkerBusy(false);
  }

  return (
    <>
      <div className="topbar">
        <div className="topbar-lead">
          <div className="topbar-heading">
            <h1 className="topbar-title">Dashboard</h1>
            <p className="topbar-status">
              <span
                className={`topbar-status__dot${running ? " topbar-status__dot--live" : ""}`}
              />
              {statusParts.join(" · ")}
            </p>
          </div>
          {!daemonOnline && (
            <button type="button" className="chip" onClick={onRestartDaemon}>
              Connect daemon
            </button>
          )}
        </div>
        <div className="topbar-actions">
          <button type="button" className="ic-btn" title="Refresh" onClick={onRefresh}>
            <RefreshCcw size={18} />
          </button>
          <div className="topbar-controls">
            <button
              type="button"
              className={`worker-btn${running ? " worker-btn--running" : ""}`}
              title={running ? "Stop worker" : "Start worker"}
              onClick={() => void toggleWorker()}
              disabled={workerBusy}
            >
              {workerBusy ? (
                <Loader2 size={16} className="spin" />
              ) : running ? (
                "Stop"
              ) : (
                "Start"
              )}
            </button>
            {!hasAddress ? (
              <button
                type="button"
                className="wallet-btn"
                title="Set operator payout address"
                onClick={() => onWalletModalOpenChange(true)}
              >
                <Wallet size={18} />
                <span>Set payout wallet</span>
              </button>
            ) : (
              <div className="profile-wrap" ref={menuRef}>
                <button
                  type="button"
                  className="profile profile-btn"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <div className="avatar">{addressAvatarLabel(operatorAddress!)}</div>
                  <div className="who">
                    <b>Operator</b>
                    <span>{truncateAddress(operatorAddress!)}</span>
                  </div>
                  <ChevronDown size={16} color="var(--muted)" />
                </button>
                {menuOpen && (
                  <div className="profile-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => void copyAddress()}>
                      Copy address
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onWalletModalOpenChange(true);
                      }}
                    >
                      Change address
                    </button>
                    <button type="button" role="menuitem" className="danger" onClick={() => void disconnect()}>
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <OperatorAddressModal
        open={walletModalOpen}
        initialAddress={operatorAddress}
        onClose={() => onWalletModalOpenChange(false)}
        onSaved={() => {
          onOperatorAddressSaved();
        }}
      />
    </>
  );
}
