// Phase 3: HTTP server. Single route POST /context. Thin wrapper over
// adaptClaudeCode (D-15). Node 20 stdlib only.

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { adaptClaudeCode } from './adapter-claude-code.js';
import { initDb } from './graph/db.js';

export interface ServeOptions {
  port?: number;
  host?: string;
  dbPath?: string;
}

export interface ServeHandle {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = 7331;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_DB = '.ctx.db';

export function serve(opts: ServeOptions = {}): Promise<ServeHandle> {
  return new Promise((resolvePromise, reject) => {
    const port = opts.port ?? DEFAULT_PORT;
    const host = opts.host ?? DEFAULT_HOST;
    const dbPath = opts.dbPath ?? DEFAULT_DB;

    const server = createServer(async (req, res) => {
      if (req.method !== 'POST' || req.url !== '/context') {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
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
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'bad request', detail: message }));
          return;
        }

        if (typeof body.task !== 'string' || body.task.length === 0) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'bad request', detail: 'missing field: task' }));
          return;
        }
        if (typeof body.repoPath !== 'string' || body.repoPath.length === 0) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'bad request', detail: 'missing field: repoPath' }));
          return;
        }

        try {
          const topK = typeof body.topK === 'number' ? body.topK : undefined;
          const result = await adaptClaudeCode(body.task, body.repoPath, { topK, dbPath });
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: 'internal', message }));
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
