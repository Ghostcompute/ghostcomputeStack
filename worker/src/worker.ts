import { io, Socket } from 'socket.io-client';
import {
  ORCHESTRATOR_URL, WORKER_TOKEN, WORKER_PUBKEY,
  GPU_MODEL, VRAM_GB, DEFAULT_MODEL, MAX_TOOL_ROUNDS,
  BENCHMARK_TOKENS, TEE_TYPE,
} from './config.js';
import { runInference, benchmarkInference, checkVllm, listModels } from './inference.js';
import { getAttestation, makeToploc, getEnclavePubkeyHex } from './attestation.js';
import type { ChatMessage, ToolDefinition, WorkerRegisterDTO } from '@ghost-compute/shared';
import { WorkerStatus, TeeType } from '@ghost-compute/shared';
import crypto from 'node:crypto';

interface JobData {
  jobId: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  think?: boolean;
  model?: string;
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function startWorker(): Promise<void> {
  if (!WORKER_TOKEN) throw new Error('WORKER_TOKEN is required');
  if (!WORKER_PUBKEY) throw new Error('WORKER_PUBKEY is required');

  // Step 1: Verify vLLM is up
  log('Checking vLLM...');
  const vllmOk = await checkVllm();
  if (!vllmOk) throw new Error('vLLM is not reachable. Set VLLM_URL and start vLLM first.');
  const models = await listModels();
  log(`vLLM ready. Models: ${models.join(', ')}`);

  // Step 2: Benchmark
  log('Benchmarking...');
  const tokPerSec = await benchmarkInference(BENCHMARK_TOKENS);
  log(`Benchmark: ${tokPerSec.toFixed(1)} tok/s`);

  // Step 3: Attestation (if TEE is available)
  const nonce = crypto.randomBytes(16).toString('hex');
  const attestation = await getAttestation(nonce);
  if (attestation) {
    log(`TEE attestation obtained: ${attestation.tee_type}`);
  } else {
    log('No TEE — running in standard mode');
  }

  // Step 4: Connect to orchestrator
  log(`Connecting to orchestrator at ${ORCHESTRATOR_URL}`);

  const socket: Socket = io(ORCHESTRATOR_URL, {
    auth: { token: WORKER_TOKEN },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  let workerId: string | null = null;
  let jobsCompleted = 0;
  let activeAbort: AbortController | null = null;
  const HEARTBEAT_MS = 15_000;
  const VLLM_HEALTH_MS = 30_000;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let vllmHealthy = true;

  function startHeartbeatLoop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (!workerId) return;
      void fetch(`${ORCHESTRATOR_URL}/v1/workers/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pubkey: WORKER_PUBKEY,
          worker_id: workerId,
          status: activeAbort ? WorkerStatus.Busy : WorkerStatus.Idle,
          jobs_completed: jobsCompleted,
          tok_per_sec: tokPerSec,
        }),
      }).catch(() => { /* orchestrator may be restarting */ });
    }, HEARTBEAT_MS);
  }

  function register() {
    const dto: WorkerRegisterDTO = {
      pubkey: WORKER_PUBKEY,
      auth_token: WORKER_TOKEN,
      model: DEFAULT_MODEL,
      tok_per_sec: Math.round(tokPerSec * 10) / 10,
      enclave_pubkey: getEnclavePubkeyHex(),
      capabilities: {
        vram_gb: VRAM_GB,
        gpu_model: GPU_MODEL,
        tok_per_sec: tokPerSec,
        tee_type: TEE_TYPE as TeeType,
        supports_vision: false,
        supports_tools: true,
        supports_thinking: true,
      },
    };

    (socket as any).emit('worker:register', {
      ...dto,
      attestation: attestation ? {
        worker_pubkey: WORKER_PUBKEY,
        tee_type: attestation.tee_type,
        nonce,
        enclave_pubkey: getEnclavePubkeyHex(),
        report_bytes: attestation.report_bytes,
        certificate_chain: attestation.certificate_chain,
        timestamp: attestation.timestamp,
      } : undefined,
    }, (res: { workerId: string } | { error: string }) => {
      if ('error' in res) {
        log(`Registration failed: ${res.error}`);
        process.exit(2);
      }
      workerId = res.workerId;
      log(`Registered as worker ${workerId}`);
      log(`GPU: ${GPU_MODEL} ${VRAM_GB}GB | TEE: ${TEE_TYPE} | ${tokPerSec.toFixed(1)} tok/s`);
      startHeartbeatLoop();
      setInterval(async () => {
        const ok = await checkVllm();
        if (ok && !vllmHealthy) {
          log('vLLM recovered');
          vllmHealthy = true;
        } else if (!ok && vllmHealthy) {
          log('WARN: vLLM health check failed — check SSH tunnel / GPU');
          vllmHealthy = false;
        }
      }, VLLM_HEALTH_MS);
    });
  }

  socket.on('connect', () => {
    log('Connected to orchestrator');
    register();
  });

  socket.on('disconnect', (reason) => {
    log(`Disconnected: ${reason}`);
    workerId = null;
  });

  socket.on('connect_error', (err) => {
    log(`Connection error: ${err.message}`);
  });

  // Wait for tool results from orchestrator
  function waitForToolResults(jobId: string, signal: AbortSignal): Promise<ChatMessage[]> {
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off(`job:tool_result:${jobId}`);
        signal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      };

      if (signal.aborted) { onAbort(); return; }

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Tool execution timed out (200s)'));
      }, 200_000);

      socket.once(`job:tool_result:${jobId}`, (data: { results: ChatMessage[] }) => {
        cleanup();
        resolve(data.results);
      });

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  socket.on('job:new', async (data: JobData) => {
    const { jobId, messages: initialMessages, tools, think, model } = data;

    if (!initialMessages?.length) {
      socket.emit('job:error', { jobId, error: 'No messages provided' });
      return;
    }

    activeAbort = new AbortController();
    const messages = [...initialMessages];
    let totalTokens = 0;
    let fullResponse = '';
    const inputHash = crypto.createHash('sha256')
      .update(JSON.stringify(messages)).digest('hex');

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let pendingTokens = '';
        let tokenFlush: ReturnType<typeof setImmediate> | null = null;
        const flushTokens = () => {
          tokenFlush = null;
          if (!pendingTokens) return;
          const batch = pendingTokens;
          pendingTokens = '';
          socket.emit('job:token', { jobId, token: batch });
        };

        const result = await runInference(
          messages,
          (token) => {
            pendingTokens += token;
            if (!tokenFlush) tokenFlush = setImmediate(flushTokens);
          },
          activeAbort.signal,
          tools,
          think ?? false,
          model ?? DEFAULT_MODEL,
        );
        if (tokenFlush) {
          clearImmediate(tokenFlush);
          flushTokens();
        }

        totalTokens += result.tokensGenerated;
        fullResponse += result.response;

        if (!result.toolCalls?.length) break;

        log(`Job ${jobId}: tool call round ${round + 1} — ${result.toolCalls.map(tc => tc.function.name).join(', ')}`);

        socket.emit('job:tool_call', { jobId, toolCalls: result.toolCalls });

        messages.push({
          role: 'assistant',
          content: result.response ?? '',
          tool_calls: result.toolCalls,
        });

        const toolResults = await waitForToolResults(jobId, activeAbort.signal);
        messages.push(...toolResults);
      }

      // Build TOPLOC commitment
      const outputHash = crypto.createHash('sha256').update(fullResponse).digest('hex');
      const toploc = makeToploc(model ?? DEFAULT_MODEL, inputHash, outputHash);

      socket.emit('job:complete', { jobId, response: fullResponse, tokensGenerated: totalTokens, toploc });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log(`Job cancelled: ${jobId}`);
        return;
      }
      log(`Job error ${jobId}: ${err.message}`);
      socket.emit('job:error', { jobId, error: err.message ?? 'Inference failed' });
    } finally {
      activeAbort = null;
    }
  });

  socket.on('job:cancel', (data: { jobId: string }) => {
    log(`Cancel requested: ${data.jobId}`);
    activeAbort?.abort();
  });

  socket.on('job:counted', (data: { jobId: string; tokensGenerated: number }) => {
    jobsCompleted++;
    log(`Job done: ${data.jobId} (${data.tokensGenerated} tokens) | Total: ${jobsCompleted}`);
  });

  async function shutdown() {
    log('Shutting down...');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    activeAbort?.abort();
    socket.emit('worker:unregister');
    socket.disconnect();
    log('Goodbye');
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
