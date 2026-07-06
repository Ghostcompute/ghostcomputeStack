#!/usr/bin/env node
/** One-off: regenerate Tauri installer/window icons from public/ghost-logo.png */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, '..');
const SOURCE = join(APP, 'public', 'ghost-logo.png');

if (!existsSync(SOURCE)) {
  throw new Error('public/ghost-logo.png not found');
}

const r = spawnSync('npx', ['tauri', 'icon', SOURCE], {
  cwd: APP,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('[icons] Tauri icons updated from public/ghost-logo.png');
