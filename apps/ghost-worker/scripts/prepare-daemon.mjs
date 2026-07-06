#!/usr/bin/env node
/**
 * Prepare worker runtime for Ghost Worker (standalone or monorepo).
 * Copies sources → src-tauri/resources/worker-python/ and builds ghost-daemon binary.
 */
import { cp, mkdir, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');
const RES_DIR = join(APP_DIR, 'src-tauri', 'resources', 'worker-python');

/** Standalone: worker-python/ lives inside the ghost-worker folder. */
const LOCAL_WORKER_PY = join(APP_DIR, 'worker-python');
/** Monorepo fallback: ghostcomupte/worker/python */
const MONOREPO_WORKER_PY = join(APP_DIR, '..', '..', 'worker', 'python');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveWorkerPyDir() {
  if (await exists(join(LOCAL_WORKER_PY, 'daemon.py'))) {
    return LOCAL_WORKER_PY;
  }
  if (await exists(join(MONOREPO_WORKER_PY, 'daemon.py'))) {
    return MONOREPO_WORKER_PY;
  }
  throw new Error(
    'worker-python not found. Expected ./worker-python/daemon.py in this folder.',
  );
}

function findSystemPython() {
  const candidates =
    process.platform === 'win32'
      ? [
          { cmd: 'python', args: [] },
          { cmd: 'py', args: ['-3'] },
          { cmd: 'python3', args: [] },
        ]
      : [
          { cmd: 'python3', args: [] },
          { cmd: 'python', args: [] },
        ];
  for (const c of candidates) {
    const r = spawnSync(c.cmd, [...c.args, '--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (r.status === 0) return c;
  }
  return null;
}

async function ensureVenv(workerPy) {
  const venvDir = join(workerPy, '.venv');
  const venvPy = join(
    venvDir,
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python3',
  );
  if (await exists(venvPy)) return venvPy;

  const sys = findSystemPython();
  if (!sys) {
    console.warn('[prepare-daemon] no Python — bundled binary will not be built');
    return null;
  }

  console.log('[prepare-daemon] creating venv in', workerPy);
  const create = spawnSync(sys.cmd, [...sys.args, '-m', 'venv', venvDir], {
    cwd: workerPy,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (create.status !== 0) return null;
  return (await exists(venvPy)) ? venvPy : null;
}

async function copySources(workerPy) {
  await mkdir(RES_DIR, { recursive: true });
  for (const file of ['daemon.py', 'hardware_detect.py', 'inference.py', 'ollama_setup.py', 'requirements.txt']) {
    await cp(join(workerPy, file), join(RES_DIR, file));
  }
  const modelsDir = join(workerPy, 'models');
  if (await exists(modelsDir)) {
    await cp(modelsDir, join(RES_DIR, 'models'), { recursive: true });
  }
  console.log('[prepare-daemon] copied → src-tauri/resources/worker-python/');
}

async function buildBundledBinary(workerPy, python) {
  const pip = spawnSync(python, ['-m', 'pip', 'install', '-q', '-U', 'pip'], {
    cwd: workerPy,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (pip.status !== 0) return false;

  const deps = spawnSync(
    python,
    ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt', 'pyinstaller>=6.0'],
    { cwd: workerPy, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (deps.status !== 0) return false;

  const build = spawnSync(
    python,
    [
      '-m', 'PyInstaller', '--clean', '--noconfirm', '--onefile',
      '--name', 'ghost-daemon',
      '--hidden-import', 'hardware_detect',
      '--hidden-import', 'inference',
      '--hidden-import', 'ollama_setup',
      '--hidden-import', 'models',
      '--hidden-import', 'models.catalog',
      '--hidden-import', 'models.manager',
      '--hidden-import', 'huggingface_hub',
      '--collect-submodules', 'huggingface_hub',
      '--hidden-import', 'certifi',
      '--hidden-import', 'websocket',
      '--hidden-import', 'pyamdgpuinfo',
      '--hidden-import', 'pynvml',
      'daemon.py',
    ],
    { cwd: workerPy, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (build.status !== 0) return false;

  const ext = process.platform === 'win32' ? '.exe' : '';
  const built = join(workerPy, 'dist', `ghost-daemon${ext}`);
  if (!(await exists(built))) return false;

  const dest = join(RES_DIR, `ghost-daemon${ext}`);
  await rm(dest, { force: true });
  await cp(built, dest);
  console.log('[prepare-daemon] bundled binary →', dest);
  return true;
}

const workerPy = await resolveWorkerPyDir();
console.log('[prepare-daemon] using', workerPy);
await copySources(workerPy);

const venvPython = await ensureVenv(workerPy);
if (venvPython) {
  console.log('[prepare-daemon] syncing worker-python dependencies…');
  spawnSync(
    venvPython,
    ['-m', 'pip', 'install', '-q', '-U', 'pip'],
    { cwd: workerPy, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  spawnSync(
    venvPython,
    ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'],
    { cwd: workerPy, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  const ok = await buildBundledBinary(workerPy, venvPython);
  if (!ok) {
    console.warn('[prepare-daemon] PyInstaller failed — will try system Python at runtime');
  }
} else {
  console.warn('[prepare-daemon] skipping bundled binary');
}
