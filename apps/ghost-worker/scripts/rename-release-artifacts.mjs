#!/usr/bin/env node
/**
 * Rename Tauri bundle outputs to human-readable release filenames.
 * Run after `tauri build` and before uploading GitHub release assets.
 *
 * Usage: node rename-release-artifacts.mjs ["--target x86_64-apple-darwin"]
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(__dirname, '..');
const TAURI_DIR = join(APP_DIR, 'src-tauri');
const TARGET_DIR = join(TAURI_DIR, 'target');

function loadVersion() {
  const conf = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8'));
  return conf.version ?? '0.0.0';
}

function parseRustTarget(argsText) {
  const m = String(argsText || '').match(/--target\s+(\S+)/);
  return m ? m[1] : null;
}

/** @param {string} name */
function friendlyName(name, version) {
  const v = version;

  if (name.endsWith('_aarch64.dmg')) {
    return `Ghost-Worker-${v}-macOS-Apple-Silicon-M1-M2-M3.dmg`;
  }
  if (name.endsWith('_x64.dmg') || name.endsWith('_x86_64.dmg')) {
    return `Ghost-Worker-${v}-macOS-Intel.dmg`;
  }
  if (name.includes('aarch64') && name.endsWith('.app.tar.gz')) {
    return `Ghost-Worker-${v}-macOS-Apple-Silicon-M1-M2-M3.app.tar.gz`;
  }
  if ((name.includes('_x64') || name.includes('x86_64')) && name.endsWith('.app.tar.gz')) {
    return `Ghost-Worker-${v}-macOS-Intel.app.tar.gz`;
  }
  if (name.endsWith('_x64-setup.exe') || name.endsWith('-setup.exe')) {
    return `Ghost-Worker-${v}-Windows-Intel-AMD64-Setup.exe`;
  }
  if (name.endsWith('_x64_en-US.msi') || name.endsWith('.msi')) {
    return `Ghost-Worker-${v}-Windows-Intel-AMD64.msi`;
  }
  if (name.endsWith('_amd64.deb')) {
    return `Ghost-Worker-${v}-Linux-Intel-AMD64.deb`;
  }
  if (name.endsWith('_amd64.AppImage') || name.endsWith('.AppImage')) {
    return `Ghost-Worker-${v}-Linux-Intel-AMD64.AppImage`;
  }
  if (name.endsWith('.rpm') || name.includes('x86_64.rpm')) {
    return `Ghost-Worker-${v}-Linux-Intel-AMD64.rpm`;
  }

  return null;
}

async function walkBundles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'bundle') {
        out.push(full);
      } else {
        await walkBundles(full, out);
      }
    }
  }
  return out;
}

async function renameInBundle(bundleDir, version) {
  const subdirs = await readdir(bundleDir, { withFileTypes: true });
  for (const sub of subdirs) {
    if (!sub.isDirectory()) continue;
    const folder = join(bundleDir, sub.name);
    const files = await readdir(folder);
    for (const file of files) {
      const next = friendlyName(file, version);
      if (!next || next === file) continue;
      const from = join(folder, file);
      const to = join(folder, next);
      await rename(from, to);
      console.log(`[release] ${file} → ${next}`);
    }
  }
}

function resolveBundleDirs(rustTarget) {
  const dirs = [];
  if (rustTarget) {
    const scoped = join(TARGET_DIR, rustTarget, 'release', 'bundle');
    if (existsSync(scoped)) dirs.push(scoped);
  }
  const native = join(TARGET_DIR, 'release', 'bundle');
  if (existsSync(native)) dirs.push(native);
  return [...new Set(dirs)];
}

const version = loadVersion();
const rustTarget = parseRustTarget(process.argv.slice(2).join(' '));
let bundleDirs = resolveBundleDirs(rustTarget);

if (!bundleDirs.length) {
  bundleDirs = await walkBundles(TARGET_DIR);
}

if (!bundleDirs.length) {
  console.warn('[release] no bundle directories found under', TARGET_DIR, rustTarget ? `(target ${rustTarget})` : '');
  process.exit(0);
}

for (const dir of bundleDirs) {
  await renameInBundle(dir, version);
}
