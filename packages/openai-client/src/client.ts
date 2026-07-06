import { Connection } from '@solana/web3.js';
import { buildX402PaymentHeader } from './payment.js';
import { parseChatCompletionStream } from './stream.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  GhostClientOptions,
  X402Challenge,
  X402Config,
} from './types.js';

function trimBaseUrl(url: string): string {
  return url.replace(/\/$/, '');
}

export class GhostOpenAI {
  readonly baseUrl: string;
  readonly payer: GhostClientOptions['payer'];
  readonly apiKey?: string;
  private rpc?: string;
  private configCache: X402Config | null = null;

  constructor(options: GhostClientOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.payer = options.payer;
    this.apiKey = options.apiKey;
    this.rpc = options.rpc;
  }

  /** OpenAI-shaped namespace */
  readonly chat = {
    completions: {
      create: (request: ChatCompletionRequest) => this.createCompletion(request),
      stream: (request: Omit<ChatCompletionRequest, 'stream'>) => this.streamCompletion(request),
    },
  };

  /** Fetch orchestrator x402 + pricing config */
  async getConfig(): Promise<X402Config> {
    if (this.configCache) return this.configCache;
    const res = await fetch(`${this.baseUrl}/api/x402/config`);
    if (!res.ok) throw new Error(`Failed to load x402 config: HTTP ${res.status}`);
    this.configCache = await res.json() as X402Config;
    if (!this.rpc) this.rpc = this.configCache.rpc;
    return this.configCache;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async connection(): Promise<Connection> {
    const cfg = await this.getConfig();
    return new Connection(this.rpc ?? cfg.rpc, 'confirmed');
  }

  private async buildPayment(challenge: X402Challenge): Promise<string> {
    const accept = challenge.accepts?.[0];
    if (!accept) throw new Error(challenge.error ?? '402 challenge missing accepts[0]');
    const connection = await this.connection();
    return buildX402PaymentHeader(connection, this.payer, accept);
  }

  private async fetchCompletion(
    body: ChatCompletionRequest,
    paymentHeader?: string,
  ): Promise<Response> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(paymentHeader ? { 'X-Payment': paymentHeader } : undefined),
      body: JSON.stringify(body),
    });

    if (res.status === 402) {
      const challenge = await res.json() as X402Challenge;
      const payment = await this.buildPayment(challenge);
      return fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers({ 'X-Payment': payment }),
        body: JSON.stringify(body),
      });
    }

    return res;
  }

  /** Non-streaming chat completion (handles 402 → pay → retry automatically). */
  async createCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const body: ChatCompletionRequest = { ...request, stream: false };
    const res = await this.fetchCompletion(body);
    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        detail = JSON.stringify(JSON.parse(text));
      } catch { /* keep raw */ }
      throw new Error(`Ghost API error ${res.status}: ${detail}`);
    }

    const data = JSON.parse(text) as ChatCompletionResponse;
    const settlement = res.headers.get('x-payment-response');
    if (settlement) data.x402_settlement = settlement;
    return data;
  }

  /** Streaming chat completion — yields OpenAI-style SSE chunks. */
  async *streamCompletion(
    request: Omit<ChatCompletionRequest, 'stream'>,
  ): AsyncGenerator<ChatCompletionChunk> {
    const body: ChatCompletionRequest = { ...request, stream: true };

    let res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (res.status === 402) {
      const challenge = await res.json() as X402Challenge;
      const payment = await this.buildPayment(challenge);
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: this.headers({ 'X-Payment': payment }),
        body: JSON.stringify(body),
      });
    }

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ghost API stream error ${res.status}: ${text.slice(0, 400)}`);
    }

    yield* parseChatCompletionStream(res.body);
  }
}

/** Convenience factory — mirrors `new OpenAI({ baseURL })` ergonomics. */
export function createGhostClient(options: GhostClientOptions): GhostOpenAI {
  return new GhostOpenAI(options);
}
