import { z } from 'zod';
import { Guarantee, TeeType } from './types.js';

export const GuaranteeSchema = z.nativeEnum(Guarantee);
export const TeeTypeSchema = z.nativeEnum(TeeType);

export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
});

export const ToolCallSchema = z.object({
  type: z.literal('function'),
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()),
  }),
});

export const ToolDefinitionSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    description: z.string(),
    parameters: z.record(z.unknown()),
  }),
});

export const WorkerCapabilitiesSchema = z.object({
  vram_gb: z.number().positive(),
  gpu_model: z.string().min(1),
  tok_per_sec: z.number().positive(),
  tee_type: TeeTypeSchema,
  supports_vision: z.boolean(),
  supports_tools: z.boolean(),
  supports_thinking: z.boolean(),
});

export const WorkerRegisterSchema = z.object({
  pubkey: z.string().length(44),
  auth_token: z.string().min(32),
  model: z.string().min(1),
  tok_per_sec: z.number().positive(),
  capabilities: WorkerCapabilitiesSchema,
});

export const JobSubmitSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1),
  tools: z.array(ToolDefinitionSchema).optional(),
  think: z.boolean().optional().default(false),
  model: z.string().optional(),
  guarantee: GuaranteeSchema.default(Guarantee.Standard),
  max_tokens: z.number().int().positive().max(32768).optional(),
  stream: z.boolean().optional().default(true),
  x402_receipt: z.string().optional(),
});

export const OrderSubmitSchema = z.object({
  side: z.enum(['buy', 'sell']),
  base_mint: z.string().length(44),
  quote_mint: z.string().length(44),
  amount: z.string().regex(/^\d+$/),
  price: z.string().regex(/^\d+$/),
  guarantee: GuaranteeSchema.default(Guarantee.Standard),
  zk_proof: z.string().optional(),
});

export const PayoutRequestSchema = z.object({
  worker_pubkey: z.string().length(44),
  amount_lamports: z.string().regex(/^\d+$/),
  signature: z.string().min(64),
});
