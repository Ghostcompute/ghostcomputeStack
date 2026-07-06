// POST /v1/chat/completions  (SSE streaming or JSON)
// Routes jobs to registered workers (Ghost Worker on the user's machine, GPU fleet nodes, etc.).
// The orchestrator does not run models — workers call Ollama/vLLM locally.

import type { Orchestrator } from '../orchestrator/orchestrator.js';
import {
  parseX402Payment,
  validateX402Receipt,
  makeX402Challenge,
  getFeeCollectorPayTo,
  getMintIds,
  createConnection,
  isSettlementEnabled,
  settleGhstFromReceipt,
  isJobRouterEnabled,
  submitJobOnChain,
  completeJobOnChain,
  resolveJobRouterOracle,
} from '@ghost-compute/solana';
import { JobSubmitSchema } from '@ghost-compute/shared';
import { Guarantee } from '@ghost-compute/shared';
import crypto from 'node:crypto';

const GHST_PRICE_PER_TOK = 100n;
const DEV_SKIP_AUTH = process.env.DEV_SKIP_AUTH === 'true';
const DEV_SKIP_X402 = process.env.DEV_SKIP_X402 === 'true';
const DEFAULT_INFERENCE_MODEL =
  process.env.DEFAULT_MODEL ?? 'meta-llama/Meta-Llama-3.1-8B-Instruct';

const NO_WORKERS_HINT =
  'No workers online. Start Ghost Worker on your machine (Ollama/vLLM runs locally on the operator PC).';

function x402Context() {
  return {
    payTo: getFeeCollectorPayTo(),
    asset: getMintIds().GHST.toBase58(),
  };
}

export function createInferenceRouter(orchestrator: Orchestrator) {
  return async function handleChatCompletions(req: any, res: any) {
    const headers = req.headers ?? {};
    const apiKey = (headers['authorization'] as string | undefined)?.replace('Bearer ', '');
    if (!apiKey && !DEV_SKIP_AUTH) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    let body: any;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const jobId = crypto.randomUUID();
    const { payTo, asset } = x402Context();
    const x402Header = headers['x-payment'] as string | undefined;
    const payment = parseX402Payment(x402Header ?? null);
    const receipt = payment?.receipt ?? null;

    const estimatedTokens = 512n;
    const requiredPayment = estimatedTokens * GHST_PRICE_PER_TOK;

    if (!DEV_SKIP_X402 && (!receipt || !validateX402Receipt(receipt, {
      minAmount: requiredPayment,
      payTo,
      asset,
    }))) {
      const challenge = makeX402Challenge(
        req.url ?? '/v1/chat/completions',
        payTo,
        requiredPayment.toString(),
        asset,
        'solana-devnet',
        jobId,
      );
      return res.status(402).json(challenge);
    }

    let settlementSig: string | null = null;
    let submitJobSig: string | null = null;

    if (!DEV_SKIP_X402 && receipt && isSettlementEnabled()) {
      const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
      const connection = createConnection(rpc);
      const settled = await settleGhstFromReceipt(connection, receipt, {
        settlementTx: payment?.settlement_tx,
      });
      if (!settled) {
        return res.status(402).json({
          error: 'On-chain GHST settlement failed',
          hint: payment?.settlement_tx
            ? 'Client settlement tx rejected — check GHST balance and payTo ATA'
            : 'Sign a GHST transfer with your wallet or enable DEV_X402_SIGN for dev',
          accepts: makeX402Challenge(
            req.url ?? '/v1/chat/completions',
            payTo,
            requiredPayment.toString(),
            asset,
            'solana-devnet',
            jobId,
          ).accepts,
        });
      }
      settlementSig = settled.signature;
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-Payment-Response', settlementSig);
      }

      if (isJobRouterEnabled()) {
        const oracle = resolveJobRouterOracle();
        if (oracle) {
          try {
            const guarantee = body.guarantee ?? Guarantee.Standard;
            submitJobSig = await submitJobOnChain(
              connection,
              oracle,
              jobId,
              guarantee,
              requiredPayment,
            );
          } catch (err) {
            console.error('[inference] submit_job failed:', (err as Error).message);
          }
        }
      }
    }

    const parsed = JobSubmitSchema.safeParse({
      messages: body.messages,
      tools: body.tools,
      think: body.stream === false ? false : body.think,
      model: body.model,
      guarantee: body.guarantee ?? Guarantee.Standard,
      max_tokens: body.max_tokens,
      stream: body.stream ?? true,
      x402_receipt: x402Header,
    });

    if (!parsed.success) {
      return res.status(422).json({ error: parsed.error.flatten() });
    }

    const isStream = parsed.data.stream;

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
    }

    const tokenBuffer: string[] = [];
    let streamedTokens = false;

    const onTokenEvent = ({ token }: { token: string }) => {
      if (isStream) {
        if (token) streamedTokens = true;
        const chunk = JSON.stringify({
          id: `chatcmpl-${jobId}`,
          object: 'chat.completion.chunk',
          model: parsed.data.model ?? 'ghost',
          choices: [{ index: 0, delta: { content: token }, finish_reason: null }],
        });
        res.write(`data: ${chunk}\n\n`);
      } else {
        tokenBuffer.push(token);
      }
    };

    orchestrator.on(`job:token:${jobId}`, onTokenEvent);

    const completion = new Promise<{ content?: string; tokensGenerated?: number; toploc?: string | null }>((resolve) => {
      const finish = (payload: { content?: string; tokensGenerated?: number; toploc?: string | null } = {}) => {
        orchestrator.off(`job:counted:${jobId}`, onCounted);
        resolve(payload);
      };
      const onCounted = (data: { content?: string; tokensGenerated?: number; toploc?: string | null }) => finish(data);
      orchestrator.once(`job:counted:${jobId}`, onCounted);
      setTimeout(() => finish({}), 120_000);
    });

    try {
      const routed = await orchestrator.routeJob({
        job_id: jobId,
        messages: parsed.data.messages as any,
        tools: parsed.data.tools,
        think: parsed.data.think ?? false,
        model: parsed.data.model ?? DEFAULT_INFERENCE_MODEL,
        guarantee: parsed.data.guarantee,
      });

      if (!routed.routed) {
        orchestrator.removeAllListeners(`job:counted:${jobId}`);
        orchestrator.off(`job:token:${jobId}`, onTokenEvent);
        if (isStream) {
          res.write(`data: ${JSON.stringify({ error: NO_WORKERS_HINT })}\n\n`);
          return res.end();
        }
        return res.status(503).json({ error: NO_WORKERS_HINT });
      }

      const result = await completion;

      if (isJobRouterEnabled() && submitJobSig) {
        const oracle = resolveJobRouterOracle();
        if (oracle) {
          try {
            const rpc = process.env.SOLANA_RPC ?? 'https://api.devnet.solana.com';
            await completeJobOnChain(createConnection(rpc), oracle, jobId, result.toploc ?? null);
          } catch (err) {
            console.error('[inference] complete_job failed:', (err as Error).message);
          }
        }
      }

      if (isStream) {
        const content = result.content ?? tokenBuffer.join('');
        if (content && !streamedTokens) {
          const chunk = JSON.stringify({
            id: `chatcmpl-${jobId}`,
            object: 'chat.completion.chunk',
            model: parsed.data.model ?? 'ghost',
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
          });
          res.write(`data: ${chunk}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      const content = result.content ?? tokenBuffer.join('');
      return res.json({
        id: `chatcmpl-${jobId}`,
        object: 'chat.completion',
        model: parsed.data.model ?? 'ghost',
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        }],
        usage: {
          completion_tokens: result.tokensGenerated ?? tokenBuffer.length,
        },
        x402_settlement: settlementSig,
        job_router_submit: submitJobSig,
      });
    } finally {
      orchestrator.off(`job:token:${jobId}`, onTokenEvent);
    }
  };
}
