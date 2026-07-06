import { VLLM_URL, DEFAULT_MODEL } from './config.js';
import type { ChatMessage, ToolCall, ToolDefinition } from '@ghost-compute/shared';

export interface InferenceResult {
  response: string;
  tokensGenerated: number;
  toolCalls?: ToolCall[];
}

export async function checkVllm(): Promise<boolean> {
  try {
    const res = await fetch(`${VLLM_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${VLLM_URL}/v1/models`);
  if (!res.ok) return [];
  const json: any = await res.json();
  return json.data?.map((m: any) => m.id) ?? [];
}

// OpenAI-compatible streaming inference via vLLM
export async function runInference(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
  tools?: ToolDefinition[],
  think = false,
  model = DEFAULT_MODEL,
): Promise<InferenceResult> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
    })),
    stream: true,
    max_tokens: think ? 32768 : 16384,
    temperature: 0.7,
  };

  if (tools?.length) body.tools = tools;

  const res = await fetch(`${VLLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`vLLM error (${res.status}): ${txt}`);
  }

  if (!res.body) throw new Error('No response body from vLLM');

  let response = '';
  let tokensGenerated = 0;
  const toolCalls: ToolCall[] = [];
  let thinkOpen = false;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') continue;
      if (!trimmed.startsWith('data: ')) continue;

      try {
        const chunk = JSON.parse(trimmed.slice(6));
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle thinking tag wrapping (for models that support <think>)
        if (think && delta.reasoning_content) {
          if (!thinkOpen) {
            response += '<think>';
            onToken('<think>');
            thinkOpen = true;
          }
          response += delta.reasoning_content;
          onToken(delta.reasoning_content);
        }

        if (delta.content) {
          if (thinkOpen) {
            response += '</think>';
            onToken('</think>');
            thinkOpen = false;
          }
          response += delta.content;
          onToken(delta.content);
          tokensGenerated++;
        }

        if (delta.tool_calls?.length) {
          toolCalls.push(...delta.tool_calls);
        }

        if (chunk.usage?.completion_tokens) {
          tokensGenerated = chunk.usage.completion_tokens;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  if (thinkOpen) {
    response += '</think>';
    onToken('</think>');
  }

  return {
    response,
    tokensGenerated,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

export async function benchmarkInference(tokenCount = 200, model = DEFAULT_MODEL): Promise<number> {
  const start = performance.now();
  let tokens = 0;

  const res = await fetch(`${VLLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Write a short paragraph about distributed GPU computing.' }],
      stream: true,
      max_tokens: tokenCount,
    }),
  });

  if (!res.ok) throw new Error(`Benchmark failed: vLLM returned ${res.status}`);
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;
      try {
        const chunk = JSON.parse(trimmed.slice(6));
        if (chunk.choices?.[0]?.delta?.content) tokens++;
        if (chunk.usage?.completion_tokens) tokens = chunk.usage.completion_tokens;
      } catch { /* skip */ }
    }
  }

  const elapsed = (performance.now() - start) / 1000;
  return tokens / elapsed;
}
