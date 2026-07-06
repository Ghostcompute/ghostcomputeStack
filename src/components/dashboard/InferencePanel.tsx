import { useState, useRef, useEffect } from 'react';
import { Connection } from '@solana/web3.js';
import { Guarantee } from '@ghost-compute/shared';
import { apiUrl } from '../../lib/api.js';
import { useSiws } from '../../hooks/use-siws.js';
import {
  buildWalletX402Payment,
  connectWalletProvider,
  fetchX402Config,
} from '../../lib/x402-wallet.js';
import { ChatMessageContent } from './ChatMessageContent.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

async function signDevX402Payment(challenge: {
  accepts?: Array<{ maxAmountRequired?: string; payTo?: string; asset?: string }>;
}): Promise<string | null> {
  const accept = challenge.accepts?.[0];
  if (!accept) return null;
  const res = await fetch(apiUrl('/api/x402/dev-sign'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: accept.maxAmountRequired,
      payTo: accept.payTo,
      asset: accept.asset,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.header as string;
}

async function signWalletX402Payment(challenge: {
  accepts?: Array<{ maxAmountRequired?: string; payTo?: string; asset?: string; extra?: { jobId?: string } }>;
}): Promise<string | null> {
  const accept = challenge.accepts?.[0];
  if (!accept?.payTo || !accept.asset) return null;

  const config = await fetchX402Config(apiUrl(''));
  const connection = new Connection(config.rpc, 'confirmed');
  const wallet = await connectWalletProvider();
  return buildWalletX402Payment(connection, wallet, accept);
}

export function InferencePanel() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [guarantee, setGuarantee] = useState<Guarantee>(Guarantee.Standard);
  const [streaming, setStreaming] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [useDevSign, setUseDevSign] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const { address, signIn, connecting, error: siwsError } = useSiws();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  async function runCompletion(
    userMessages: Message[],
    paymentHeader?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    if (paymentHeader) headers['X-Payment'] = paymentHeader;

    return fetch(apiUrl('/v1/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: userMessages.map(m => ({ role: m.role, content: m.content })),
        guarantee,
        stream: true,
      }),
      signal: abortRef.current?.signal,
    });
  }

  async function send() {
    if (!input.trim() || streaming) return;

    const userMsg: Message = { role: 'user', content: input };
    const history = [...messages, userMsg];
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setStreaming(true);

    const abort = new AbortController();
    abortRef.current = abort;

    const assistantMsg: Message = { role: 'assistant', content: '' };
    setMessages(prev => [...prev, assistantMsg]);

    try {
      let res = await runCompletion(history);

      if (res.status === 402) {
        const challenge = await res.json();
        let paymentHeader: string | null = null;

        if (useDevSign) {
          paymentHeader = await signDevX402Payment(challenge);
        } else {
          try {
            paymentHeader = await signWalletX402Payment(challenge);
          } catch (walletErr) {
            console.warn('[x402] wallet payment failed, trying dev-sign fallback:', walletErr);
            paymentHeader = await signDevX402Payment(challenge);
          }
        }

        if (!paymentHeader) {
          setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = {
              role: 'assistant',
              content: `[x402: payment failed — connect wallet or enable dev sign. ${challenge.accepts?.[0]?.maxAmountRequired ?? '?'} GHST required]`,
            };
            return next;
          });
          return;
        }
        res = await runCompletion(history, paymentHeader);
      }

      if (!res.ok || !res.body) throw new Error(`API error ${res.status}`);

      const settlementTx = res.headers.get('x-payment-response');
      if (settlementTx) {
        console.log('[x402] settlement tx:', settlementTx);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const chunk = JSON.parse(line.slice(6));
            const token = chunk.choices?.[0]?.delta?.content ?? '';
            if (token) {
              setMessages(prev => {
                const next = [...prev];
                next[next.length - 1] = {
                  role: 'assistant',
                  content: next[next.length - 1].content + token,
                };
                return next;
              });
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setMessages(prev => {
          const next = [...prev];
          next[next.length - 1] = { role: 'assistant', content: `Error: ${err.message}` };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="inference-panel">
      <div className="inference-header">
        <h3>Private Inference</h3>
        <select value={guarantee} onChange={e => setGuarantee(e.target.value as Guarantee)}>
          <option value={Guarantee.Standard}>Standard</option>
          <option value={Guarantee.High}>High (TEE)</option>
          <option value={Guarantee.MaxTrustSplit}>MaxTrustSplit (MPC+FHE)</option>
        </select>
      </div>

      <div className="inference-wallet">
        {address ? (
          <span className="wallet-addr">Wallet: {address.slice(0, 4)}…{address.slice(-4)}</span>
        ) : (
          <button type="button" onClick={() => signIn()} disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect Wallet (SIWS)'}
          </button>
        )}
        <label className="dev-sign-toggle">
          <input type="checkbox" checked={useDevSign} onChange={e => setUseDevSign(e.target.checked)} />
          Dev server sign (fallback)
        </label>
        {siwsError && <span className="wallet-error">{siwsError}</span>}
      </div>

      <div className="inference-messages">
        {messages.length === 0 && !streaming && (
          <p className="inference-empty">Send a message to start chatting…</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg--${m.role}`}>
            <span className="msg__role">{m.role}</span>
            <div className="msg__content">
              {m.role === 'assistant' ? (
                <ChatMessageContent content={m.content} />
              ) : (
                m.content
              )}
            </div>
          </div>
        ))}
        {streaming && messages[messages.length - 1]?.content === '' && (
          <div className="msg msg--typing">...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="inference-input">
        <input
          type="text"
          placeholder="API key (optional in dev if DEV_SKIP_AUTH=true)"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          className="api-key-input"
        />
        <input
          type="text"
          placeholder="Message..."
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          className="msg-input"
        />
        <button onClick={streaming ? () => abortRef.current?.abort() : send}>
          {streaming ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}
