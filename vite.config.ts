import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

/* ─── In-memory rate limiter (Vercel KV substitute for dev) ─────────────────
   PRD §2.1 — 10 requests per minute per client IP                          */

const rateLimitMap = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (rateLimitMap.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return hits.length > RATE_MAX;
}

/* ─── SSRF guard (authoritative server-side check) ──────────────────────────
   PRD §2.1 — mirrors client-side ssrfGuard; this one actually blocks        */

function ssrfGuard(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Malformed URL'; }
  if (!/^https?:$/.test(u.protocol)) return 'Only HTTP/HTTPS allowed';
  const h = u.hostname.toLowerCase();
  const deny = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '169.254.169.254', '::ffff:169.254.169.254'];
  if (deny.includes(h)) return `SSRF blocked: ${h}`;
  const m = h.match(/^(\d+)\.(\d+)/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (a === 10) return 'RFC 1918 blocked: 10.x.x.x';
    if (a === 172 && b >= 16 && b <= 31) return 'RFC 1918 blocked: 172.16–31.x.x';
    if (a === 192 && b === 168) return 'RFC 1918 blocked: 192.168.x.x';
  }
  return null;
}

/* ─── Status text map ────────────────────────────────────────────────────── */

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 408: 'Request Timeout', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

/* ─── Telemetry proxy plugin ─────────────────────────────────────────────────
   PRD §2   — Edge Runtime proxy (Vite middleware substitute for dev)
   PRD §2.2 — redirect:'manual' via undici maxRedirections:0 so 3xx is
              captured explicitly with Location header, not silently followed  */

function telemetryProxyPlugin() {
  return {
    name: 'astonal-telemetry-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(
        '/api/telemetry',
        async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== 'POST') {
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method Not Allowed' }));
            return;
          }

          // Read request body
          let rawBody = '';
          for await (const chunk of req) rawBody += chunk as string;

          let targetUrl: string;
          try {
            const parsed = JSON.parse(rawBody) as { url?: string };
            if (!parsed.url) throw new Error('missing url');
            targetUrl = parsed.url;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Body must be JSON: { "url": "..." }' }));
            return;
          }

          // Rate limit per client IP
          const forwarded = req.headers['x-forwarded-for'];
          const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
            ?? req.socket.remoteAddress
            ?? '0.0.0.0';

          if (isRateLimited(ip)) {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Rate limit exceeded: 10 requests per minute' }));
            return;
          }

          // Authoritative SSRF guard
          const guardErr = ssrfGuard(targetUrl);
          if (guardErr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: guardErr }));
            return;
          }

          // Proxy fetch — undici request with maxRedirections:0 gives raw 3xx
          // with Location header intact (impossible with browser fetch redirect:'manual')
          const t0 = Date.now();
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 12_000);

          try {
            const { request } = await import('undici');
            const { statusCode, headers: rawHeaders, body: bodyStream } = await request(
              targetUrl,
              { signal: ctrl.signal, maxRedirections: 0 },
            );
            clearTimeout(timer);
            const ttfb = Date.now() - t0;

            const isRedirect = statusCode >= 300 && statusCode < 400;

            // Normalise headers to [key, value][] (undici values can be string|string[]|undefined)
            const headersArr: [string, string][] = [];
            for (const [k, v] of Object.entries(rawHeaders)) {
              if (Array.isArray(v)) v.forEach(val => headersArr.push([k, val]));
              else if (v !== undefined) headersArr.push([k, v]);
            }

            let responseBody = '';
            if (!isRedirect) {
              const chunks: Buffer[] = [];
              for await (const chunk of bodyStream) chunks.push(chunk as Buffer);
              responseBody = Buffer.concat(chunks).toString('utf-8').slice(0, 512_000);
            } else {
              bodyStream.destroy();
            }

            const total = Date.now() - t0;
            const contentType = headersArr.find(([k]) => k === 'content-type')?.[1] ?? '';
            const locationHeader = headersArr.find(([k]) => k === 'location')?.[1] ?? null;

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: statusCode,
              statusText: STATUS_TEXT[statusCode] ?? 'Unknown',
              timing: { ttfb, total },
              headers: headersArr,
              redirected: isRedirect,
              redirectLocation: isRedirect ? locationHeader : null,
              body: responseBody,
              contentType,
              error: null,
            }));
          } catch (ex) {
            clearTimeout(timer);
            const isTimeout = (ex as { name?: string }).name === 'AbortError';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              status: isTimeout ? 408 : 0,
              statusText: isTimeout ? 'Request Timeout' : 'Proxy / Network Error',
              timing: { ttfb: 0, total: Date.now() - t0 },
              headers: [],
              redirected: false,
              redirectLocation: null,
              body: '',
              contentType: '',
              error: ex instanceof Error ? ex.message : 'Unknown proxy error',
            }));
          }
        },
      );
    },
  };
}

/* ─── Vite config ────────────────────────────────────────────────────────── */

export default defineConfig({
  plugins: [react(), telemetryProxyPlugin()],
});
