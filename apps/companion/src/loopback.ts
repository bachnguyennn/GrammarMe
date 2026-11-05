/**
 * The loopback redirect listener for sign-in: 127.0.0.1 only, GET /auth/callback only. It answers
 * the first valid-looking callback with a tiny static page and hands the query to the caller.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { CALLBACK_PATH } from './config.ts';
import { parseCallback } from './oauth.ts';

export interface CallbackServer {
  port: number;
  redirectUri: string;
  /** Resolves with the callback's query parameters. */
  result: Promise<URLSearchParams>;
  close(): Promise<void>;
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1d1f;background:#fff}@media (prefers-color-scheme:dark){body{color:#f2f2f2;background:#161616}}h1{font-size:1.25rem}</style></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      server.off('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startCallbackServer(options: { expectedState: string; preferredPort?: number }): Promise<CallbackServer> {
  let deliver!: (params: URLSearchParams) => void;
  const result = new Promise<URLSearchParams>((resolve) => {
    deliver = resolve;
  });
  let port = 0;
  let handled = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, html: string) => {
      res.writeHead(status, PAGE_HEADERS);
      res.end(html);
    };
    // Reject other Host names (DNS rebinding) and anything but GET /auth/callback.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}` || handled) {
      reply(404, page('Not found', 'Nothing to see here.'));
      return;
    }
    handled = true;
    const check = parseCallback(url.searchParams, options.expectedState);
    if (check.ok) reply(200, page('Connected', 'You can close this tab and return to GrammarMe.'));
    else reply(400, page('ChatGPT wasn’t connected', `${check.message} You can close this tab.`));
    deliver(url.searchParams);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;

  const preferred = options.preferredPort ?? 0;
  try {
    port = await listen(server, preferred);
  } catch (e) {
    if (preferred === 0 || (e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    port = await listen(server, 0);
  }

  let closed = false;
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
    result,
    close: () =>
      new Promise<void>((resolve) => {
        if (closed) return resolve();
        closed = true;
        server.close(() => resolve());
        // Let the response we just sent finish, then drop keep-alive connections.
        setTimeout(() => server.closeAllConnections(), 250).unref();
      }),
  };
}
