// Phase 3 + 7: HTTP server. POST /context (adapter) + GET /api/* (dashboard)
// + GET / static dashboard files. Node 20 stdlib only.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { adaptClaudeCode } from './adapter-claude-code.js';
import { initDb } from './graph/db.js';
import { handleApi } from './dashboard/api.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  dashboardDir?: string;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DB = '.ctx.db';
const DEFAULT_DASHBOARD = resolve(process.cwd(), 'dashboard', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function serveStatic(res: ServerResponse, dashboardDir: string, urlPath: string): void {
  // Resolve within dashboardDir only (no path traversal).
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = resolve(dashboardDir, rel);
  if (!filePath.startsWith(resolve(dashboardDir))) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback to index.html for client routes.
    const index = join(dashboardDir, 'index.html');
    if (existsSync(index)) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end(readFileSync(index));
      return;
    }
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', MIME[extname(filePath)] ?? 'application/octet-stream');
  res.end(readFileSync(filePath));
}

export function serve(opts: ServeOptions = {}): Promise<ServeHandle> {
  return new Promise((resolvePromise, reject) => {
    const port = opts.port ?? DEFAULT_PORT;
    const host = opts.host ?? DEFAULT_HOST;
    const dbPath = opts.dbPath ?? DEFAULT_DB;
    const dashboardDir = opts.dashboardDir ?? DEFAULT_DASHBOARD;

    const server = createServer(async (req, res) => {
      const url = req.url ?? '/';

      // Dashboard read-only API.
      if (req.method === 'GET' && url.startsWith('/api/')) {
        const db = initDb(dbPath);
        try {
          const r = handleApi(db, url);
          sendJson(res, r.status, r.body);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: 'internal', message });
        } finally {
          db.close();
        }
        return;
      }

      // Static dashboard files.
      if (req.method === 'GET') {
        serveStatic(res, dashboardDir, url);
        return;
      }

      // POST /context (adapter).
      if (req.method !== 'POST' || url !== '/context') {
        sendJson(res, 404, { error: 'not found' });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', async () => {
        let body: { task?: unknown; repoPath?: unknown; topK?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 400, { error: 'bad request', detail: message });
          return;
        }

        if (typeof body.task !== 'string' || body.task.length === 0) {
          sendJson(res, 400, { error: 'bad request', detail: 'missing field: task' });
          return;
        }
        if (typeof body.repoPath !== 'string' || body.repoPath.length === 0) {
          sendJson(res, 400, { error: 'bad request', detail: 'missing field: repoPath' });
          return;
        }

        try {
          const topK = typeof body.topK === 'number' ? body.topK : undefined;
          const result = await adaptClaudeCode(body.task, body.repoPath, { topK, dbPath });
          sendJson(res, 200, result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: 'internal', message });
        }
      });
    });

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error('port in use: ' + port));
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolvePromise({
        port: actualPort,
        async close(): Promise<void> {
          await new Promise<void>((r) => server.close(() => r()));
        },
      });
    });
  });
}
