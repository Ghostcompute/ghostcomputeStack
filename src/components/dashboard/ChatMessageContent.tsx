import { Check, Copy } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';

type Segment =
  | { type: 'text'; value: string }
  | { type: 'code'; lang: string; value: string; partial?: boolean };

const FENCE_RE = /```([\w#+.:-]*)\n?([\s\S]*?)```/g;
const FILE_REF_RE = /(@[\w./-]+\.(?:ts|tsx|js|jsx|py|rs|json|md|css|html|sql|sh|yaml|yml|toml|txt|go|java|cpp|c|h))/gi;
const AT_FILE_BLOCK_RE =
  /^@([\w./-]+\.(ts|tsx|js|jsx|py|rs|json|md|css|html|sql|sh|yaml|yml|toml|txt|go|java|cpp|c|h))\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/gim;

const EXT_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  py: 'python',
  rs: 'rust',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  sh: 'bash',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  txt: 'text',
  go: 'go',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
};

function normalizeAtFileBlocks(content: string): string {
  return content.replace(AT_FILE_BLOCK_RE, (_match, path: string, code: string) => {
    const trimmed = code.trimEnd();
    if (!trimmed.trim()) return `@${path}`;
    const ext = path.split('.').pop()?.toLowerCase() ?? 'text';
    const lang = EXT_LANG[ext] ?? ext;
    return `\`\`\`${lang}\n${trimmed}\n\`\`\``;
  });
}

function parseSegments(content: string): Segment[] {
  const normalized = normalizeAtFileBlocks(content);
  const segments: Segment[] = [];
  let last = 0;
  let match: RegExpExecArray | null;

  FENCE_RE.lastIndex = 0;
  while ((match = FENCE_RE.exec(normalized)) !== null) {
    if (match.index > last) {
      segments.push({ type: 'text', value: normalized.slice(last, match.index) });
    }
    segments.push({
      type: 'code',
      lang: match[1]?.trim() || 'text',
      value: match[2].replace(/\n$/, ''),
    });
    last = match.index + match[0].length;
  }

  if (last < normalized.length) {
    const tail = normalized.slice(last);
    const open = tail.indexOf('```');
    if (open >= 0) {
      if (open > 0) segments.push({ type: 'text', value: tail.slice(0, open) });
      const afterFence = tail.slice(open + 3);
      const nl = afterFence.indexOf('\n');
      const lang = (nl >= 0 ? afterFence.slice(0, nl) : afterFence).trim();
      const code = nl >= 0 ? afterFence.slice(nl + 1) : '';
      segments.push({
        type: 'code',
        lang: lang || 'text',
        value: code,
        partial: true,
      });
    } else {
      segments.push({ type: 'text', value: tail });
    }
  }

  if (segments.length === 0 && normalized) {
    segments.push({ type: 'text', value: normalized });
  }

  return segments;
}

function CodeBlock({
  lang,
  code,
  partial,
}: {
  lang: string;
  code: string;
  partial?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className={`code-block${partial ? ' code-block--partial' : ''}`}>
      <div className="code-block__head">
        <span className="code-block__lang">{lang}</span>
        <button
          type="button"
          className="code-block__copy"
          onClick={() => void copy()}
          disabled={!code.trim()}
          aria-label="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code-block__pre">
        <code>{code}{partial && <span className="code-block__cursor">▍</span>}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string, keyPrefix: string) {
  const parts: ReactNode[] = [];
  let i = 0;

  const pushPlain = (plain: string) => {
    if (!plain) return;
    const fileParts = plain.split(FILE_REF_RE);
    fileParts.forEach((bit, j) => {
      if (!bit) return;
      if (j % 2 === 1) {
        parts.push(
          <code key={`${keyPrefix}-f-${i++}`} className="inline-file">
            {bit}
          </code>,
        );
        return;
      }
      const inlineParts = bit.split(/(`[^`\n]+`)/g);
      inlineParts.forEach((seg, k) => {
        if (!seg) return;
        if (seg.startsWith('`') && seg.endsWith('`')) {
          parts.push(
            <code key={`${keyPrefix}-c-${i++}-${k}`} className="inline-code">
              {seg.slice(1, -1)}
            </code>,
          );
        } else {
          parts.push(<Fragment key={`${keyPrefix}-t-${i++}-${k}`}>{seg}</Fragment>);
        }
      });
    });
  };

  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) parts.push(<br key={`${keyPrefix}-br-${lineIdx}`} />);
    pushPlain(line);
  });

  return parts;
}

export function ChatMessageContent({ content }: { content: string }) {
  if (!content) return null;

  const segments = parseSegments(content);

  return (
    <div className="chat-md">
      {segments.map((seg, idx) =>
        seg.type === 'code' ? (
          <CodeBlock
            key={`code-${idx}`}
            lang={seg.lang}
            code={seg.value}
            partial={seg.partial}
          />
        ) : (
          <p key={`text-${idx}`} className="chat-md__p">
            {renderInline(seg.value, `p-${idx}`)}
          </p>
        ),
      )}
    </div>
  );
}
