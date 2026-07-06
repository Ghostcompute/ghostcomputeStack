import '../../../../../scripts/load-env.js';
import http from 'node:http';
import { createClient } from '@supabase/supabase-js';
import { Server as IOServer } from 'socket.io';
import { Orchestrator } from './orchestrator.js';
import { ORCHESTRATOR_PORT } from './config.js';
import { createInferenceRouter } from '../inference/router.js';
import { DarkPoolEngine } from '../darkpool/engine.js';
import { SealedDarkPool } from '../darkpool/sealed.js';
import { getFleetStats } from '../fleet/stats.js';
import { runSettlementCycle } from '../settlement/relayer.js';
import { getLeaderboard, getPoints } from '../indexer/points.js';
import { issueNonce, authenticateSiws } from '../auth/siws.js';
import { processAttestation, getAttestationByHash } from '../attestation/service.js';
import { getNetworkStats, getWorkerReputation, getReceipts, getAuditFeed, getEnclaveKey, getLiveFeed, getAttestationList, getChainEvents } from '../explorer/explorer.js';
import { startChainIndexer, pollChainEvents, isChainIndexerEnabled } from '../indexer/chain-poller.js';
import { createConnection } from '@ghost-compute/solana';
import { wrapHttpResponse } from '../inference/http-res.js';
import {
  buildDevX402Receipt,
  encodeX402Header,
  getFeeCollectorPayTo,
  getMintIds,
  loadDevWallet,
  distributeVaultBalanceIfReady,
} from '@ghost-compute/solana';
import {
  ghstDecimals,
  ghstPer1MOutputTokens,
  ghstPerOutputToken,
  ghstRawPerOutputToken,
} from '@ghost-compute/shared';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${ORCHESTRATOR_PORT}`);
  const path = url.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Payment');
  res.setHeader('Access-Control-Expose-Headers', 'X-Payment-Response');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, fleet: orchestrator.getFleetStats() }));
  }

  // Fleet stats (Supabase aggregates + live orchestrator state)
  if (path === '/api/fleet') {
    let stats = null;
    try {
      stats = await getFleetStats();
    } catch {
      stats = null;
    }
    const live = orchestrator.getFleetStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ...(stats ?? {
        active_workers: live.total,
        total_jobs_24h: 0,
        avg_tok_per_sec: live.avg_tok_per_sec,
        total_ghst_paid_24h: '0',
        p50_latency_ms: 0,
        p99_latency_ms: 0,
      }),
      live: {
        ws_workers_online: live.ws_workers_online,
        ws_workers_busy: live.ws_workers_busy,
        jobs_in_queue: live.jobs_in_queue,
        jobs_in_flight: live.jobs_in_flight,
      },
      workers: orchestrator.listWorkers(),
    }));
  }

  // Points leaderboard
  if (path === '/api/points/leaderboard') {
    const board = await getLeaderboard(100);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(board.map(e => ({ ...e, total: e.total.toString() }))));
  }

  // Settlement trigger (cron or manual)
  if (path === '/api/settle' && req.method === 'POST') {
    const result = await runSettlementCycle();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  // Dark pool order submission
  if (path === '/api/orders' && req.method === 'POST') {
    const body = await readBody(req);
    const dto = JSON.parse(body);
    const orderId = await darkPool.submitOrder(dto);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ order_id: orderId }));
  }

  // Dark pool order book
  if (path.startsWith('/api/orderbook/')) {
    const [baseMint, quoteMint] = path.replace('/api/orderbook/', '').split('/');
    const book = darkPool.getOrderBook(baseMint, quoteMint);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      bids: book.bids.map(o => ({ ...o, amount_raw: o.amount_raw.toString(), price_raw: o.price_raw.toString() })),
      asks: book.asks.map(o => ({ ...o, amount_raw: o.amount_raw.toString(), price_raw: o.price_raw.toString() })),
    }));
  }

  // ── Auth (SIWS) ──────────────────────────────────────────────────────────
  if (path === '/api/auth/nonce' && req.method === 'POST') {
    const nonce = await issueNonce();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ nonce }));
  }
  if (path === '/api/auth/siws' && req.method === 'POST') {
    try {
      const { token, address } = await authenticateSiws(JSON.parse(await readBody(req)));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ token, address }));
    } catch (err) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // ── Attestation (P3) ─────────────────────────────────────────────────────
  if (path === '/api/attestation' && req.method === 'POST') {
    const { quote, expectedNonce } = JSON.parse(await readBody(req));
    const result = await processAttestation(quote, expectedNonce);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }
  if (path.startsWith('/api/attestation/') && req.method === 'GET') {
    const hash = path.replace('/api/attestation/', '');
    const data = await getAttestationByHash(hash);
    res.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(data ?? { error: 'not found' }));
  }

  // ── Enclave key registry (P2) ────────────────────────────────────────────
  if (path.startsWith('/api/enclave-keys/') && req.method === 'GET') {
    const key = await getEnclaveKey(path.replace('/api/enclave-keys/', ''));
    res.writeHead(key ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(key ?? { error: 'no active enclave key' }));
  }

  // ── Attestation Explorer (P7) ────────────────────────────────────────────
  if (path === '/api/explorer/network') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getNetworkStats()));
  }
  if (path === '/api/explorer/workers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getWorkerReputation(50)));
  }
  if (path === '/api/explorer/receipts') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getReceipts(50)));
  }
  if (path === '/api/explorer/audits') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getAuditFeed(50)));
  }
  if (path === '/api/explorer/feed') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getLiveFeed(30)));
  }
  if (path === '/api/explorer/attestations') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getAttestationList(20)));
  }
  if (path === '/api/explorer/chain-events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(await getChainEvents(50)));
  }

  if (path === '/api/indexer/poll' && req.method === 'POST') {
    if (!isChainIndexerEnabled()) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'CHAIN_INDEXER_ENABLED is false' }));
    }
    const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
    const inserted = await pollChainEvents(createConnection(rpc));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ inserted }));
  }

  if (path === '/api/darkpool/matches') {
    const matches = await darkPool.getRecentMatches(20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(matches));
  }

  if (path === '/api/orders/sealed' && req.method === 'POST') {
    const body = await readBody(req);
    const dto = JSON.parse(body);
    const orderId = await sealedPool.submitSealedOrder(dto);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ order_id: orderId }));
  }

  if (path === '/api/darkpool/sealed') {
    const rows = await sealedPool.listSealedOrders(20);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(rows));
  }

  // ── Pricing (orchestrator-controlled — workers + dashboard read this) ───
  if (path === '/api/pricing' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ghstPerOutputToken: ghstPerOutputToken(),
      ghstPer1MOutputTokens: ghstPer1MOutputTokens(),
      ghstDecimals: ghstDecimals(),
      ghstRawPerOutputToken: ghstRawPerOutputToken().toString(),
    }));
  }

  // ── x402 dev sign (local testing only) ───────────────────────────────────
  if (path === '/api/x402/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      rpc: process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com',
      ghstMint: getMintIds().GHST.toBase58(),
      payTo: getFeeCollectorPayTo(),
      network: 'solana-devnet',
      skipAuth: process.env.DEV_SKIP_AUTH === 'true',
      skipX402: process.env.DEV_SKIP_X402 === 'true',
      devSignEnabled: process.env.DEV_X402_SIGN === 'true',
      siwsDomain: process.env.SIWS_DOMAIN ?? 'localhost',
      ghstPerOutputToken: ghstPerOutputToken(),
      ghstPer1MOutputTokens: ghstPer1MOutputTokens(),
      ghstDecimals: ghstDecimals(),
    }));
  }

  if (path === '/api/x402/dev-sign' && req.method === 'POST') {
    const devSignEnabled = process.env.DEV_X402_SIGN === 'true';
    if (!devSignEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Dev x402 signing disabled' }));
    }
    try {
      const body = JSON.parse(await readBody(req));
      const amount = String(body.amount ?? body.maxAmountRequired ?? '0');
      const payTo = String(body.recipient ?? body.payTo ?? getFeeCollectorPayTo());
      const asset = String(body.asset ?? getMintIds().GHST.toBase58());
      const receipt = buildDevX402Receipt(loadDevWallet(), payTo, asset, amount);
      const header = encodeX402Header(receipt);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ header, receipt }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // ── Workers (REST liveness + fleet) ───────────────────────────────────────
  if (path === '/api/workers/register' && req.method === 'POST') {
    try {
      const dto = JSON.parse(await readBody(req));
      const ip = req.socket.remoteAddress ?? 'unknown';
      const result = await orchestrator.registerDesktopWorker({
        pubkey: String(dto.pubkey ?? ''),
        auth_token: String(dto.auth_token ?? ''),
        model: String(dto.model ?? process.env.DEFAULT_MODEL ?? 'unknown'),
        tok_per_sec: Number(dto.tok_per_sec ?? 1),
        capabilities: dto.capabilities ?? {},
        enclave_pubkey: dto.enclave_pubkey,
        ip,
      });
      if ('error' in result) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: result.error }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ workerId: result.workerId }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  if (path === '/api/workers/heartbeat' && req.method === 'POST') {
    try {
      const dto = JSON.parse(await readBody(req));
      const ok = orchestrator.heartbeat(String(dto.pubkey ?? ''), {
        status: dto.status,
        jobsCompleted: dto.jobs_completed,
        tokPerSec: dto.tok_per_sec,
      });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  if (path === '/api/jobs/next' && req.method === 'GET') {
    const pubkey = url.searchParams.get('pubkey') ?? '';
    const payload = orchestrator.pollJobForPubkey(pubkey);
    if (!payload) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ job: null }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      job: {
        id: payload.jobId,
        model: payload.model,
        messages: payload.messages,
        guarantee: payload.guarantee,
        confidential: payload.confidential ?? false,
        max_tokens: payload.maxTokens ?? 16384,
      },
    }));
  }

  if (path === '/api/jobs/complete' && req.method === 'POST') {
    try {
      const dto = JSON.parse(await readBody(req));
      const pubkey = String(dto.pubkey ?? dto.worker_pubkey ?? '');
      const ok = orchestrator.completeJobForPubkey(pubkey, {
        jobId: String(dto.jobId ?? dto.job_id ?? ''),
        content: dto.content,
        tokens_generated: dto.tokens_generated,
        ttft_ms: dto.ttft_ms,
        tpot_ms: dto.tpot_ms,
        attestation_hash: dto.attestation_hash ?? null,
        toploc: dto.toploc ?? null,
      });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  if (path === '/api/jobs/token' && req.method === 'POST') {
    try {
      const dto = JSON.parse(await readBody(req));
      const pubkey = String(dto.pubkey ?? dto.worker_pubkey ?? '');
      const ok = orchestrator.emitJobTokenForPubkey(
        pubkey,
        String(dto.jobId ?? dto.job_id ?? ''),
        String(dto.token ?? ''),
      );
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  if (path === '/v1/workers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ workers: orchestrator.listWorkers() }));
  }
  if (path === '/v1/workers/heartbeat' && req.method === 'POST') {
    try {
      const dto = JSON.parse(await readBody(req));
      const ok = orchestrator.heartbeat(String(dto.pubkey ?? ''), {
        status: dto.status,
        jobsCompleted: dto.jobs_completed,
        tokPerSec: dto.tok_per_sec,
      });
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  // Inference — OpenAI-compat
  if (path === '/v1/chat/completions') {
    const body = await readBody(req);
    return inferenceHandler({ headers: req.headers, body, url: req.url } as any, wrapHttpResponse(res) as any);
  }

  res.writeHead(404);
  res.end('Not found');
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const io = new IOServer(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
});

const orchestrator = new Orchestrator(io);
const darkPool     = new DarkPoolEngine();
const sealedPool   = new SealedDarkPool(
  createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE ?? ''),
);
const inferenceHandler = createInferenceRouter(orchestrator);

server.listen(ORCHESTRATOR_PORT, () => {
  console.log(`[orchestrator] Listening on :${ORCHESTRATOR_PORT}`);
  startChainIndexer();
});

// Settlement cron: every 10 minutes
setInterval(() => {
  runSettlementCycle().catch(err => console.error('[settle]', err.message));
}, 10 * 60 * 1000);

// Fee distribution cron (60/20/10/10 split when vault exceeds threshold)
if (process.env.FEE_DISTRIBUTE_ENABLED === 'true') {
  const feeIntervalMs = Number(process.env.FEE_DISTRIBUTE_INTERVAL_MS ?? 30 * 60 * 1000);
  const feeMinRaw = BigInt(process.env.FEE_DISTRIBUTE_MIN_RAW ?? '51200');
  const feeTick = () => {
    try {
      const wallet = loadDevWallet();
      const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
      distributeVaultBalanceIfReady(createConnection(rpc), wallet, feeMinRaw)
        .then(sig => { if (sig) console.log(`[fees] distributed → ${sig}`); })
        .catch(err => console.error('[fees]', err.message));
    } catch (err) {
      console.error('[fees]', (err as Error).message);
    }
  };
  console.log(`[fees] distribution cron started (every ${feeIntervalMs}ms)`);
  feeTick();
  setInterval(feeTick, feeIntervalMs);
}
