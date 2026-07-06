import type { ServerResponse } from 'node:http';

/** Minimal Express-like helpers for the raw Node HTTP server. */
export function wrapHttpResponse(res: ServerResponse) {
  let statusCode = 200;

  return {
    status(code: number) {
      statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      res.setHeader(name, value);
      return this;
    },
    write(chunk: string) {
      if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'text/event-stream' });
      }
      res.write(chunk);
      return this;
    },
    flushHeaders() {
      if (!res.headersSent) {
        res.writeHead(statusCode);
      }
      return this;
    },
    json(body: unknown) {
      if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify(body));
      return this;
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.end(chunk);
      else if (!res.headersSent) {
        res.writeHead(statusCode);
        res.end();
      } else res.end();
      return this;
    },
  };
}
