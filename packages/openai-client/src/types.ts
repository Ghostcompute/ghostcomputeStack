export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type Guarantee = 'standard' | 'high' | 'max_trust_split';

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  stream?: boolean;
  guarantee?: Guarantee;
  think?: boolean;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: 'assistant'; content: string };
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    completion_tokens?: number;
  };
  x402_settlement?: string | null;
}

export interface ChatCompletionChunk {
  id?: string;
  object?: string;
  model?: string;
  choices: Array<{
    index: number;
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}

export interface GhostClientOptions {
  /** Orchestrator base URL, e.g. https://api.ghostcompute.tech */
  baseUrl: string;
  /** Solana keypair that holds GHST and signs x402 payments */
  payer: import('@solana/web3.js').Keypair;
  /** Optional Bearer token when orchestrator auth is enabled */
  apiKey?: string;
  /** Solana RPC for building settlement txs (defaults to /api/x402/config) */
  rpc?: string;
}

export interface X402Config {
  rpc: string;
  ghstMint: string;
  payTo: string;
  network?: string;
  ghstPerOutputToken?: number;
  ghstDecimals?: number;
}

export interface X402Accept {
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
  network?: string;
}

export interface X402Challenge {
  x402Version?: number;
  accepts?: X402Accept[];
  error?: string;
}
