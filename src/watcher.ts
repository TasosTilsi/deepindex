// Phase 3: Watcher. chokidar-based, debounced cache invalidation.
// No auto-repair (D-04): on file change, drop the affected summary cache
// entry; the user invokes `ctx repair` explicitly.

import chokidar from 'chokidar';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { cacheDelete } from './cache.js';
import { sha256 } from './fingerprint.js';

export interface WatcherOptions {
  roots?: string[];
  debounceMs?: number;
  ignored?: string[] | null;
  dbPath: string;
  onInvalidate?: (relPath: string) => void;
}

export interface WatcherHandle {
  close(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 250;

export function createWatcher(opts: WatcherOptions): WatcherHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const cwd = process.cwd();
  const defaultRoots = [cwd, resolve(cwd, 'src')].filter((p) => existsSync(p));
  const roots = (opts.roots && opts.roots.length > 0 ? opts.roots : defaultRoots).map((r) =>
    resolve(r)
  );

  // Validate db path up-front. Open a single read-only handle for the
  // lifetime of the watcher; close it on close().
  const db = new Database(opts.dbPath, { readonly: true });

  const ignored =
    opts.ignored === null
      ? ['**/.ctx/**', '**/node_modules/**', '**/.git/**']
      : [...(opts.ignored ?? []), '**/.ctx/**', '**/node_modules/**', '**/.git/**'];

  const timers = new Map<string, NodeJS.Timeout>();

  const watcher = chokidar.watch(roots, {
    ignored,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  const onEvent = (absPath: string) => {
    const existing = timers.get(absPath);
    if (existing) clearTimeout(existing);
    timers.set(
      absPath,
      setTimeout(() => {
        timers.delete(absPath);
        const rel = relative(cwd, absPath);
        const key = 'summary:' + sha256(absPath);
        try {
          cacheDelete(db, key);
        } catch {
          // best-effort; log but don't crash
          console.error(`watcher: cacheDelete failed for ${rel}`);
        }
        console.log(`invalidated: ${rel}`);
        if (opts.onInvalidate) opts.onInvalidate(rel);
      }, debounceMs)
    );
  };

  watcher.on('add', onEvent);
  watcher.on('change', onEvent);
  watcher.on('unlink', onEvent);

  return {
    async close(): Promise<void> {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      try {
        await watcher.close();
      } finally {
        try {
          db.close();
        } catch {
          // already closed
        }
      }
    },
  };
}
