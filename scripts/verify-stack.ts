/**
 * End-to-end stack verification for Ghost Compute dev/demo.
 * Usage: pnpm verify:stack
 */
import './load-env.js';

const ORCHESTRATOR = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3001';
const VLLM_URL = process.env.VLLM_URL ?? 'http://localhost:8000';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function getJson(path: string): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetch(`${ORCHESTRATOR}${path}`);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message };
  }
}

async function main() {
  const checks: Check[] = [];

  const health = await getJson('/health');
  checks.push({
    name: 'orchestrator /health',
    ok: health.ok,
    detail: health.ok ? 'ok' : String(health.body),
  });

  const fleet = await getJson('/api/fleet');
  const workers = (fleet.body as { workers?: unknown[] })?.workers ?? [];
  checks.push({
    name: 'fleet API',
    ok: fleet.ok,
    detail: fleet.ok ? `${workers.length} worker(s)` : String(fleet.body),
  });

  const feed = await getJson('/api/explorer/feed');
  checks.push({
    name: 'live feed API',
    ok: feed.ok && Array.isArray(feed.body),
    detail: feed.ok ? `${(feed.body as unknown[]).length} item(s)` : String(feed.body),
  });

  const attest = await getJson('/api/explorer/attestations');
  checks.push({
    name: 'attestations API',
    ok: attest.ok && Array.isArray(attest.body),
    detail: attest.ok ? `${(attest.body as unknown[]).length} row(s)` : String(attest.body),
  });

  const x402 = await getJson('/api/x402/config');
  const cfg = x402.body as { payTo?: string; skipAuth?: boolean; devSignEnabled?: boolean };
  checks.push({
    name: 'x402 config',
    ok: x402.ok && !!cfg?.payTo,
    detail: x402.ok ? `${cfg.payTo!.slice(0, 12)}… · auth=${cfg.skipAuth ? 'skip' : 'siws'} · devSign=${cfg.devSignEnabled}` : String(x402.body),
  });

  const chain = await getJson('/api/explorer/chain-events');
  checks.push({
    name: 'chain events API',
    ok: chain.ok && Array.isArray(chain.body),
    detail: chain.ok ? `${(chain.body as unknown[]).length} event(s)` : String(chain.body),
  });

  const matches = await getJson('/api/darkpool/matches');
  checks.push({
    name: 'dark pool matches API',
    ok: matches.ok && Array.isArray(matches.body),
    detail: matches.ok ? `${(matches.body as unknown[]).length} match(es)` : String(matches.body),
  });

  try {
    const res = await fetch(`${VLLM_URL}/health`, { signal: AbortSignal.timeout(4000) });
    checks.push({
      name: 'vLLM health',
      ok: res.ok,
      detail: res.ok ? VLLM_URL : `HTTP ${res.status}`,
    });
  } catch (err) {
    checks.push({
      name: 'vLLM health',
      ok: false,
      detail: `${VLLM_URL} — ${(err as Error).message}`,
    });
  }

  const requireVllm = process.env.VERIFY_VLLM_REQUIRED === 'true';

  console.log('\nGhost Compute — stack verification\n');
  let failed = 0;
  for (const c of checks) {
    const soft = c.name === 'vLLM health' && !requireVllm;
    const mark = c.ok ? '✓' : soft ? '!' : '✗';
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}${soft && !c.ok ? ' (optional — start gpu-tunnel)' : ''}`);
    if (!c.ok && !soft) failed++;
  }

  console.log('');
  if (failed) {
    console.log(`${failed} check(s) failed. Fix the items above and re-run pnpm verify:stack`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
