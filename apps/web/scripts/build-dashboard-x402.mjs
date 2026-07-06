import esbuild from 'esbuild';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outRoot = join(here, '../../../public/dashboard-x402.bundle.mjs');
const outApp = join(here, '../public/dashboard-x402.bundle.mjs');

for (const outfile of [outRoot, outApp]) {
  esbuild.buildSync({
    entryPoints: [join(here, 'dashboard-x402-browser-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2020'],
    outfile,
    define: { 'process.env.NODE_DEBUG': 'false' },
    banner: { js: '/* Ghost dashboard x402 wallet bundle — pnpm build:dashboard-x402 */' },
  });
  console.log(`${outfile} (${statSync(outfile).size} bytes)`);
}
