#!/usr/bin/env node
/**
 * Install vLLM into the Ghost Worker Python venv.
 *
 * Linux/macOS: official PyPI vllm package.
 * Windows: SystemPanic/vllm-windows release wheel (CUDA 13 + PyTorch 2.11).
 *
 * Usage:
 *   pnpm ghost-worker:prepare:vllm
 *   pnpm ghost-worker:prepare:vllm -- --recreate-venv
 *
 * Override wheel URL (Windows):
 *   set VLLM_WINDOWS_WHEEL_URL=https://github.com/.../vllm-....whl
 */
import { spawnSync } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');
const WORKER_PY = join(APP_DIR, 'worker-python');
const VENV_DIR = join(WORKER_PY, '.venv');
const VENV_PY = join(
  WORKER_PY,
  process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python3',
);

const VLLM_WINDOWS_REPO = 'SystemPanic/vllm-windows';
const TORCH_CUDA_INDEX = 'https://download.pytorch.org/whl/cu130';
const RECREATE_VENV = process.argv.includes('--recreate-venv');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  return result.status ?? 1;
}

function runCapture(cmd, args) {
  const isExe = typeof cmd === 'string' && /\.(exe|cmd)$/i.test(cmd);
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32' && !isExe,
  });
}

function pythonTag(pythonExe) {
  const r = runCapture(pythonExe, [
    '-c',
    'import sys; print(f"cp{sys.version_info.major}{sys.version_info.minor}")',
  ]);
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function findWindowsPython312Exe() {
  const py = runCapture('py', ['-3.12', '-c', 'import sys; print(sys.executable)']);
  if (py.status === 0 && py.stdout.trim()) return py.stdout.trim();
  const direct = runCapture('python3.12', ['-c', 'import sys; print(sys.executable)']);
  if (direct.status === 0 && direct.stdout.trim()) return direct.stdout.trim();
  return null;
}

function findSystemPython() {
  for (const cmd of ['python3', 'python']) {
    const r = runCapture(cmd, ['--version']);
    if (r.status === 0) return cmd;
  }
  return null;
}

async function ensureVenv(requiredTag = null) {
  if (RECREATE_VENV && (await exists(VENV_DIR))) {
    console.log('[prepare-vllm] removing existing venv (--recreate-venv)');
    await rm(VENV_DIR, { recursive: true, force: true });
  }

  if ((await exists(VENV_PY)) && requiredTag) {
    const current = pythonTag(VENV_PY);
    if (current !== requiredTag) {
      console.warn(
        `[prepare-vllm] venv is ${current} but vLLM wheel needs ${requiredTag}.`,
      );
      if (!RECREATE_VENV) {
        console.error(
          `[prepare-vllm] Re-run with --recreate-venv after installing Python ${requiredTag.replace('cp', '')}:\n` +
            `  https://www.python.org/downloads/\n` +
            `  pnpm ghost-worker:prepare:vllm -- --recreate-venv`,
        );
        process.exit(1);
      }
      await rm(VENV_DIR, { recursive: true, force: true });
    } else {
      return VENV_PY;
    }
  }

  if (await exists(VENV_PY)) return VENV_PY;

  let creator;
  if (process.platform === 'win32' && requiredTag === 'cp312') {
    creator = findWindowsPython312Exe();
    if (!creator) {
      console.error(
        '[prepare-vllm] Python 3.12 required for SystemPanic vLLM wheel (current builds are cp312).\n' +
          '  1. Install Python 3.12: https://www.python.org/downloads/release/python-3120/\n' +
          '  2. pnpm ghost-worker:prepare:vllm -- --recreate-venv\n' +
          '  Or use Ollama models in the Models tab (no vLLM install needed).',
      );
      process.exit(1);
    }
  } else {
    creator = findSystemPython();
    if (!creator) {
      console.error('[prepare-vllm] Python not found — run: pnpm ghost-worker:prepare');
      process.exit(1);
    }
  }

  console.log('[prepare-vllm] creating venv →', VENV_DIR);
  if (run(creator, ['-m', 'venv', VENV_DIR], { cwd: WORKER_PY }) !== 0) {
    console.error('[prepare-vllm] failed to create venv');
    process.exit(1);
  }
  if (!(await exists(VENV_PY))) {
    console.error('[prepare-vllm] venv python not found after create');
    process.exit(1);
  }
  return VENV_PY;
}

async function fetchLatestWindowsWheel() {
  const override = process.env.VLLM_WINDOWS_WHEEL_URL?.trim();
  if (override) {
    const name = override.split('/').pop()?.split('?')[0] ?? 'vllm-windows.whl';
    return {
      name,
      url: override,
      tag: name.match(/(cp\d+)/)?.[1] ?? 'cp312',
    };
  }

  const res = await fetch(
    `https://api.github.com/repos/${VLLM_WINDOWS_REPO}/releases/latest`,
    { headers: { 'User-Agent': 'ghost-worker-prepare-vllm' } },
  );
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} fetching ${VLLM_WINDOWS_REPO} latest release`);
  }
  const release = await res.json();
  const assets = (release.assets ?? []).filter((a) =>
    /^vllm-.*-win_amd64\.whl$/i.test(a.name),
  );
  if (!assets.length) {
    throw new Error(`No Windows wheel in ${VLLM_WINDOWS_REPO} release ${release.tag_name}`);
  }
  const pick =
    assets.find((a) => a.name.includes('-cp312-')) ??
    assets.find((a) => a.name.includes('-cp313-')) ??
    assets[assets.length - 1];
  const tag = pick.name.match(/(cp\d+)-cp\d+-win_amd64/i)?.[1] ?? 'cp312';
  return {
    name: pick.name,
    url: pick.browser_download_url,
    tag,
    release: release.tag_name,
  };
}

async function installWindowsVllm() {
  console.log('[prepare-vllm] Windows → https://github.com/SystemPanic/vllm-windows');
  const wheel = await fetchLatestWindowsWheel();
  console.log(`[prepare-vllm] wheel: ${wheel.name} (${wheel.release ?? 'custom URL'})`);

  const venvPy = await ensureVenv(wheel.tag);

  console.log('[prepare-vllm] upgrading pip…');
  if (run(venvPy, ['-m', 'pip', 'install', '-U', 'pip']) !== 0) process.exit(1);

  console.log('[prepare-vllm] installing PyTorch 2.11 (CUDA 13)…');
  if (
    run(venvPy, [
      '-m',
      'pip',
      'install',
      'torch==2.11+cu130',
      'torchaudio==2.11+cu130',
      'torchvision==0.26.0+cu130',
      '--index-url',
      TORCH_CUDA_INDEX,
    ]) !== 0
  ) {
    console.error('[prepare-vllm] PyTorch install failed');
    process.exit(1);
  }

  console.log('[prepare-vllm] installing vLLM wheel…');
  if (
    run(venvPy, [
      '-m',
      'pip',
      'install',
      wheel.url,
      '--extra-index-url',
      TORCH_CUDA_INDEX,
    ]) !== 0
  ) {
    console.error(
      '[prepare-vllm] vLLM wheel install failed.\n' +
        '  Releases: https://github.com/SystemPanic/vllm-windows/releases\n' +
        '  Override: set VLLM_WINDOWS_WHEEL_URL=<direct .whl URL>',
    );
    process.exit(1);
  }

  return venvPy;
}

async function installLinuxVllm(venvPy) {
  console.log('[prepare-vllm] installing vLLM from PyPI…');
  if (run(venvPy, ['-m', 'pip', 'install', '-U', 'pip']) !== 0) process.exit(1);
  if (
    run(venvPy, ['-m', 'pip', 'install', '-r', 'requirements-vllm.txt'], {
      cwd: WORKER_PY,
    }) !== 0
  ) {
    process.exit(1);
  }
  return venvPy;
}

let venvPy;

if (process.platform === 'win32') {
  venvPy = await installWindowsVllm();
} else {
  if (!(await exists(VENV_PY)) && !RECREATE_VENV) {
    console.error('[prepare-vllm] venv missing — run: pnpm ghost-worker:prepare');
    process.exit(1);
  }
  venvPy = await ensureVenv();
  await installLinuxVllm(venvPy);
}

const verify = runCapture(venvPy, ['-c', 'import vllm; print(vllm.__version__)'], {
  cwd: WORKER_PY,
});
if (verify.status !== 0) {
  console.error('[prepare-vllm] vLLM import failed after install');
  process.exit(1);
}

console.log('[prepare-vllm] vLLM', verify.stdout.trim(), 'ready in', WORKER_PY);
console.log(
  '[prepare-vllm] Restart Ghost Worker → Models → pick a vLLM model → start worker.',
);
