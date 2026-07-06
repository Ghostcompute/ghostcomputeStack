#!/usr/bin/env node
/** Desktop tweaks after copying dashboard.html → index.html */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const indexPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
let html = await readFile(indexPath, 'utf8');

html = html.replace(
  '<title>Ghost Compute   Console</title>',
  `<title>Ghost Worker · Console</title>
<script type="module">
  if (import.meta.env.PROD) {
    const base = __GHOST_ORCHESTRATOR_URL__.replace(/\\/$/, '');
    const orig = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api') || url.startsWith('/v1')) {
        return orig(base + url, init);
      }
      return orig(input, init);
    };
  }
</script>`,
);

html = html.replaceAll(`href="/"`, `href="#" onclick="return false"`);
html = html.replace(
  `onclick="window.open('/','_self')"`,
  `onclick="toast('Ghost Worker desktop')"`,
);
html = html.replace(
  `import('/dashboard-x402.bundle.mjs?v=2')`,
  `import('./dashboard/dashboard-x402.bundle.mjs')`,
);
html = html.replace(
  `from '/dashboard-fleet.mjs'`,
  `from './dashboard/dashboard-fleet.mjs'`,
);
html = html.replace(
  `from '/dashboard-attestation.mjs?v=1'`,
  `from './dashboard/dashboard-attestation.mjs'`,
);
html = html.replace(
  `from '/dashboard-darkpool.mjs?v=2'`,
  `from './dashboard/dashboard-darkpool.mjs'`,
);
html = html.replace(
  `from '/dashboard-points.mjs?v=1'`,
  `from './dashboard/dashboard-points.mjs'`,
);
html = html.replace(
  `from '/dashboard-auth.mjs?v=1'`,
  `from './dashboard/dashboard-auth.mjs'`,
);
html = html.replace('>Back to site<', '>Ghost Worker<');

await writeFile(indexPath, html);
console.log('[patch-dashboard] applied desktop tweaks');
