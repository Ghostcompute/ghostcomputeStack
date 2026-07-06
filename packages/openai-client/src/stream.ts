import type { ChatCompletionChunk } from './types.js';

/** Parse OpenAI-style SSE from /v1/chat/completions stream. */
export async function* parseChatCompletionStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatCompletionChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const payload = JSON.parse(line.slice(6)) as ChatCompletionChunk & { error?: string };
          if (payload.error) throw new Error(payload.error);
          if (payload.choices?.length) yield payload;
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
