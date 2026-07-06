import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { fetchWorkerStatus, getDaemonApi, setOperatorWallet } from "../lib/daemon-api";
import { getStoredOperatorAddress } from "../lib/operator-address";
import type { DaemonStatus, VllmStatus, WorkerStatus } from "../types";

async function tauriInvoke<T>(cmd: string): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<T>(cmd);
  } catch {
    return null;
  }
}

export function useDaemon() {
  const [processStatus, setProcessStatus] = useState<DaemonStatus | null>(null);
  const [vllmStatus, setVllmStatus] = useState<VllmStatus | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [connecting, setConnecting] = useState(true);

  const refresh = useCallback(async () => {
    const proc = await tauriInvoke<DaemonStatus>("daemon_status");
    if (proc) setProcessStatus(proc);

    const vllm = await tauriInvoke<VllmStatus>("vllm_status");
    if (vllm) setVllmStatus(vllm);

    let worker = (await fetchWorkerStatus()) as WorkerStatus | null;

    const saved = getStoredOperatorAddress();
    if (saved && worker && worker.worker_address !== saved) {
      await setOperatorWallet(saved);
      worker = (await fetchWorkerStatus()) as WorkerStatus | null;
    }

    setWorkerStatus(worker);
    setConnecting(false);

    if (!worker && isTauri() && !proc?.healthy) {
      const started = await tauriInvoke<DaemonStatus>("daemon_start");
      if (started) setProcessStatus(started);
      let retry = (await fetchWorkerStatus()) as WorkerStatus | null;
      if (retry && saved && retry.worker_address !== saved) {
        await setOperatorWallet(saved);
        retry = (await fetchWorkerStatus()) as WorkerStatus | null;
      }
      if (retry) setWorkerStatus(retry);
    }

    return { proc, vllm, worker };
  }, []);

  const restartDaemon = useCallback(async () => {
    setConnecting(true);
    if (isTauri()) {
      const started = await tauriInvoke<DaemonStatus>("daemon_start");
      if (started) setProcessStatus(started);
    }
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void (async () => {
      if (isTauri()) await tauriInvoke("daemon_start");
      await refresh();
    })();
  }, [refresh]);

  useEffect(() => {
    const ms = workerStatus?.running ? 1500 : 3000;
    const id = setInterval(() => void refresh(), ms);
    return () => clearInterval(id);
  }, [refresh, workerStatus?.running]);

  const daemonOnline = !!(processStatus?.healthy || workerStatus);

  return {
    connecting,
    daemonOnline,
    processStatus,
    vllmStatus,
    workerStatus,
    refresh,
    restartDaemon,
  };
}

export async function workerStart(): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${getDaemonApi()}/worker/start`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      message?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        message: body.message ?? body.error ?? `Start failed (${res.status})`,
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Daemon unreachable" };
  }
}

export async function workerStop(): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${getDaemonApi()}/worker/stop`, { method: "POST" });
    if (!res.ok) return { ok: false, message: `Stop failed (${res.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Daemon unreachable" };
  }
}
