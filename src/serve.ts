// Phase 3 + 7: HTTP server. POST /context (adapter) + GET /api/* (dashboard)
// + GET / static dashboard files. Node 20 stdlib only.

import type Database from 'better-sqlite3';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { adaptClaudeCode } from './adapter-claude-code.js';
import { initDb } from './graph/db.js';
import { handleApi } from './dashboard/api.js';
import { ensureVecTables } from './semantic/vec.js';
import { getProject, defaultRegistryPath } from './registry.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  dashboardDir?: string;
  registryPath?: string;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DB = '.deepindex.db';
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

/** Copy a db (+ its -wal side file) into a private temp dir and open the
 *  copy. Used when the source db lives outside a writable area (e.g. another
 *  project's directory under a restricted server environment): SQLite cannot
 *  create its WAL/shm side files there. The dashboard is read-only either
 *  way, so serving from a copy is equivalent. Returns null when the source
 *  is unusable. */
function openDbCopy(
  source: string,
  copyDirs: Set<string>
): Database.Database | null {
  try {
    if (!existsSync(source) || !statSync(source).isFile()) return null;
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-serve-'));
    copyDirs.add(dir);
    const copyPath = join(dir, 'index.db');
    copyFileSync(source, copyPath);
    const wal = `${source}-wal`;
    if (existsSync(wal)) copyFileSync(wal, `${copyPath}-wal`);
    return initDb(copyPath);
  } catch {
    return null;
  }
}

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
  // Vite build outputs under /assets/ carry content-hashed filenames — safe to
  // cache forever. Everything else (index.html, SPA fallback) must revalidate
  // so rebuilt dashboards are picked up on refresh.
  res.setHeader(
    'cache-control',
    urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
  );
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
    const registryPath = opts.registryPath ?? defaultRegistryPath();
    // One connection per db file, reused across requests. initDb re-executes
    // the full schema DDL + WAL pragmas on every call, so opening a fresh
    // connection per request adds fixed latency to every dashboard endpoint.
    const openHandles = new Map<string, Database.Database>();
    // Temp dirs holding copies of dbs that could not be opened in place.
    const copyDirs = new Set<string>();

    const server = createServer(async (req, res) => {
      const url = req.url ?? '/';

      // Dashboard read-only API.
      if (req.method === 'GET' && url.startsWith('/api/')) {
        // Resolve the project's db: ?project=<name> selects a registered
        // project; otherwise use the default dbPath.
        const u = new URL(url, 'http://localhost');
        const projectKey = u.searchParams.get('project');
        let dbForApi = dbPath;
        // REVIEW-FIX W5: the registry project path is the rootDir for API
        // handlers (semantic config + md corpus are project-relative). Using
        // process.cwd() for a remote project read the WRONG .deepindex.toml
        // and the WRONG markdown corpus.
        let projectRoot = process.cwd();
        if (projectKey) {
          const proj = getProject(projectKey, registryPath);
          if (proj) {
            dbForApi = proj.dbPath;
            projectRoot = proj.path;
          }
        }
        // Opening the db inside the try: an unopenable project db (missing
        // file, a directory, or a db outside a writable area) must answer
        // with a 500, not kill the server process.
        let db: Database.Database | undefined;
        try {
          db = openHandles.get(dbForApi);
          if (!db) {
            try {
              db = initDb(dbForApi);
            } catch (err) {
              const copy = openDbCopy(dbForApi, copyDirs);
              if (!copy) throw err;
              db = copy;
            }
            openHandles.set(dbForApi, db);
            // Prepare vec capability on this connection (per-connection
            // sqlite-vec load — RESEARCH §1.6). ensureVecTables REPORTS
            // failure via { ok: false } instead of throwing (RSK-2) — no
            // try/catch needed; a missing extension only leaves semantic
            // search degraded.
            ensureVecTables(db);
          }
          const r = await handleApi(db, url, registryPath, projectRoot);
          sendJson(res, r.status, r.body);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: 'cannot open database', detail: message, path: dbForApi });
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
          for (const h of openHandles.values()) h.close();
          openHandles.clear();
          for (const d of copyDirs) rmSync(d, { recursive: true, force: true });
          copyDirs.clear();
        },
      });
    });
  });
}
