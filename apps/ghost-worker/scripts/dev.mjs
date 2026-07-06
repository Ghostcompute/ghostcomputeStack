#!/usr/bin/env node
/** Dev: ensure local daemon is up, then start Vite. */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..");
const DAEMON_PORT = 7421;
const BIN = join(APP, "src-tauri/resources/worker-python/ghost-daemon");
const PY = join(APP, "worker-python/daemon.py");
const WORKER_PY = join(APP, "worker-python");
const VENV_PY = join(
  WORKER_PY,
  process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python3",
);
const REQUIREMENTS = join(WORKER_PY, "requirements.txt");

function resolvePython() {
  if (existsSync(VENV_PY)) return VENV_PY;
  if (spawnSync("python3", ["--version"]).status === 0) return "python3";
  return "python";
}

function ensureWorkerDeps(python) {
  if (!existsSync(REQUIREMENTS)) return;
  console.log("[dev] ensuring worker-python dependencies…");
  const r = spawnSync(
    python,
    ["-m", "pip", "install", "-q", "-r", REQUIREMENTS],
    { cwd: WORKER_PY, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (r.status !== 0) {
    console.warn("[dev] pip install requirements failed — model downloads may not work");
  }
}

function fileExists(p) {
  return existsSync(p);
}

async function exists(p) {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function daemonUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`);
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchDaemonStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function normPath(p) {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** True when :7421 is served by this ghost-worker folder (not another install). */
async function daemonMatchesThisApp() {
  const status = await fetchDaemonStatus();
  if (!status) return false;

  const appRoot = normPath(APP);
  const daemonRoot = normPath(String(status.daemon_root || ""));
  if (daemonRoot) {
    return daemonRoot === appRoot;
  }

  const script = normPath(String(status.daemon_script || ""));
  if (script && script.includes(appRoot)) {
    return true;
  }

  const exe = normPath(String(status.python_executable || ""));
  if (exe.includes(appRoot)) {
    return true;
  }

  // New auto-setup daemons expose this flag; old installs should be replaced.
  return status.features?.ollama_auto_setup === true && exe.includes("/worker-python/");
}

/** True when an existing daemon has model-download deps (venv Python in dev). */
async function daemonEnvOk() {
  const status = await fetchDaemonStatus();
  if (!status) return false;
  if (status.huggingface_hub === true) return true;
  if (!existsSync(VENV_PY)) return true;
  const exe = normPath(String(status.python_executable || ""));
  const venv = normPath(VENV_PY);
  return exe === venv || exe.endsWith("/.venv/scripts/python.exe") || exe.endsWith("/.venv/bin/python3");
}

function killPort(port) {
  if (process.platform === "win32") {
    const r = spawnSync("netstat", ["-ano"], { encoding: "utf8", shell: true });
    for (const line of r.stdout.split("\n")) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== "0") {
        spawnSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore", shell: true });
      }
    }
    return;
  }
  spawnSync("sh", ["-c", `lsof -ti :${port} | xargs -r kill -9`], { stdio: "ignore" });
}

async function isForeignDaemon() {
  if (process.platform !== "win32") return false;
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/status`);
    if (!res.ok) return false;
    const data = await res.json();
    const gpu = data?.gpu;
    if (!gpu) return false;
    if (gpu.source === "pyamdgpuinfo") return true;
    if (gpu.driver === "amdgpu") return true;
    if (typeof gpu.pci_slot === "string" && gpu.pci_slot.startsWith("0000:")) return true;
    return false;
  } catch {
    return false;
  }
}

function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(join(APP, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch {
    /* optional */
  }
  return env;
}

async function ensureDaemon() {
  if (await daemonUp()) {
    if (await isForeignDaemon()) {
      console.warn(
        "[dev] port 7421 is served by a Linux/WSL daemon (wrong GPU). " +
          "Close that port forward or WSL worker, then restart dev.",
      );
      killPort(DAEMON_PORT);
      await new Promise((r) => setTimeout(r, 600));
    } else if (!(await daemonMatchesThisApp())) {
      const status = await fetchDaemonStatus();
      console.warn(
        "[dev] port 7421 is owned by another Ghost Worker install — restarting local daemon",
      );
      if (status?.daemon_root) {
        console.warn(`[dev]   running: ${status.daemon_root}`);
      } else if (status?.python_executable) {
        console.warn(`[dev]   running: ${status.python_executable}`);
      }
      console.warn(`[dev]   expected: ${APP}`);
      killPort(DAEMON_PORT);
      await new Promise((r) => setTimeout(r, 600));
    } else if (!(await daemonEnvOk())) {
      console.log(
        "[dev] daemon on :7421 is missing huggingface_hub (wrong Python) — restarting with venv",
      );
      killPort(DAEMON_PORT);
      await new Promise((r) => setTimeout(r, 600));
    } else {
      console.log("[dev] daemon already on :7421 (this project)");
      return null;
    }
  }

  const env = loadEnv();
  let child = null;

  // Dev: prefer live Python sources so daemon changes apply without rebuilding PyInstaller.
  if (await exists(PY)) {
    const py = resolvePython();
    ensureWorkerDeps(py);
    console.log("[dev] starting python daemon (source)");
    child = spawn(py, [PY, "--port", String(DAEMON_PORT)], {
      cwd: WORKER_PY,
      env,
      stdio: "ignore",
      detached: true,
    });
  } else if (fileExists(BIN)) {
    console.log("[dev] starting bundled ghost-daemon");
    child = spawn(BIN, ["--port", String(DAEMON_PORT)], {
      cwd: join(APP, "worker-python"),
      env,
      stdio: "ignore",
      detached: true,
    });
  } else {
    console.warn("[dev] no daemon found — run: npm run prepare:daemon");
    return null;
  }

  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await daemonUp()) {
      console.log("[dev] daemon ready");
      return child;
    }
  }
  console.warn("[dev] daemon did not respond in time");
  return child;
}

await ensureDaemon();

const viteBin = join(APP, "node_modules", "vite", "bin", "vite.js");
const vite = existsSync(viteBin)
  ? spawn(process.execPath, [viteBin], { cwd: APP, stdio: "inherit" })
  : spawn("npx", ["vite"], {
      cwd: APP,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

vite.on("exit", (code) => process.exit(code ?? 0));
