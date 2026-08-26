import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { store } from '../store.js';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Static assets (html/css/js) are NOT compiled by tsc, so they stay under
 * `src/web/public`. Resolve that folder relative to the project root so the
 * server works both in dev (tsx, __dirname = src/web) and prod
 * (node dist, __dirname = dist/web).
 */
function resolvePublicDir(): string {
  const candidates = [
    path.resolve(__dirname, 'public'),                    // dev: src/web/public
    path.resolve(__dirname, '..', '..', 'src', 'web', 'public'), // prod: dist/web → src/web/public
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

const PUBLIC_DIR = resolvePublicDir();

/**
 * Runtime status the bridge exposes to the dashboard. `index.ts` keeps this
 * object up to date as Zalo/Telegram connectivity changes.
 */
export interface BridgeStatus {
  zaloConnected: boolean;
  telegramConnected: boolean;
  zaloName?: string;
  startedAt: number;
}

/** Callbacks the web layer needs from the rest of the app. */
export interface WebServerHooks {
  /** Current live status of the bridge. */
  getStatus: () => BridgeStatus;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function notFound(res: ServerResponse): void {
  sendJSON(res, 404, { error: 'Not found' });
}

/** Collect a request body and parse it as JSON (empty body → {}). */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  // Normalise & prevent path traversal.
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return notFound(res);
  if (!existsSync(filePath)) return notFound(res);

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

/**
 * Start the management web server.
 * Serves the dashboard UI and a small JSON API over the topic store.
 */
export function startWebServer(hooks: WebServerHooks, port: number): void {
  const server = createServer((req, res) => {
    void handle(req, res, hooks).catch((err) => {
      console.error('[Web] Request error:', err);
      if (!res.headersSent) sendJSON(res, 500, { error: String(err?.message ?? err) });
    });
  });

  server.on('error', (err) => {
    console.error(`[Web] Server error (port ${port}):`, err);
  });

  server.listen(port, () => {
    console.log(`[Web] Dashboard available at http://localhost:${port} ✓`);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, hooks: WebServerHooks): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  const method = req.method ?? 'GET';

  // ── API routes ──────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    // GET /api/status
    if (pathname === '/api/status' && method === 'GET') {
      const status = hooks.getStatus();
      return sendJSON(res, 200, {
        ...status,
        uptimeSec: Math.floor((Date.now() - status.startedAt) / 1000),
        telegramGroupId: config.telegram.groupId,
        topicCount: store.all().length,
      });
    }

    // GET /api/topics
    if (pathname === '/api/topics' && method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
      let topics = store.all();
      if (q) {
        topics = topics.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.zaloId.toLowerCase().includes(q) ||
            String(t.topicId).includes(q),
        );
      }
      // Newest-ish first is not tracked; sort by name for stable display.
      topics = [...topics].sort((a, b) => a.name.localeCompare(b.name));
      return sendJSON(res, 200, {
        total: topics.length,
        topics: topics.map((t) => ({
          topicId: t.topicId,
          zaloId: t.zaloId,
          type: t.type,
          typeLabel: t.type === 1 ? 'group' : 'user',
          name: t.name,
        })),
      });
    }

    // DELETE /api/topics/:topicId
    const delMatch = pathname.match(/^\/api\/topics\/(\d+)$/);
    if (delMatch && method === 'DELETE') {
      const topicId = Number(delMatch[1]);
      const removed = store.remove(topicId);
      if (!removed) return sendJSON(res, 404, { error: `No mapping for topic ${topicId}` });
      return sendJSON(res, 200, { removed });
    }

    // POST /api/reload  — re-read topics.json from disk
    if (pathname === '/api/reload' && method === 'POST') {
      await readBody(req).catch(() => ({}));
      store.reload();
      return sendJSON(res, 200, { ok: true, topicCount: store.all().length });
    }

    return notFound(res);
  }

  // ── Static files (dashboard UI) ───────────────────────────────────────────
  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(res, pathname);
  }

  notFound(res);
}
