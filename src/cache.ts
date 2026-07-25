import Database from 'better-sqlite3';
import { fingerprint, sha256 } from './fingerprint.js';
import type { CacheStats, Fingerprint } from './types.js';

const DEFAULT_CAPACITY_BYTES = 100 * 1024 * 1024; // 100 MB

export interface CacheOptions {
  capacityBytes?: number;
}

export function cacheSet(
  db: Database.Database,
  key: string,
  content: string,
  opts: CacheOptions = {}
): Fingerprint {
  const capacity = opts.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
  const now = Date.now();
  const existing = db
    .prepare('SELECT hash, version FROM cache WHERE key = ?')
    .get(key) as { hash: string; version: number } | undefined;

  let version = 1;
  if (existing) {
    if (existing.hash === sha256(content)) {
      db.prepare(
        'UPDATE cache SET last_access = ? WHERE key = ?'
      ).run(now, key);
      const row = db
        .prepare('SELECT * FROM cache WHERE key = ?')
        .get(key) as CacheRow;
      return rowToFingerprint(row);
    }
    version = existing.version + 1;
  }

  const fp = fingerprint(content, {}, version);
  db.prepare(
    `INSERT INTO cache (key, content, hash, version, confidence, size, updated_at, last_access)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       content = excluded.content,
       hash = excluded.hash,
       version = excluded.version,
       confidence = excluded.confidence,
       size = excluded.size,
       updated_at = excluded.updated_at,
       last_access = excluded.last_access`
  ).run(
    key,
    content,
    fp.hash,
    fp.version,
    fp.confidence,
    fp.size,
    now,
    now
  );

  evictIfNeeded(db, capacity);
  return fp;
}

export function cacheGet(
  db: Database.Database,
  key: string
): { content: string; fingerprint: Fingerprint } | null {
  const row = db.prepare('SELECT * FROM cache WHERE key = ?').get(key) as
    | CacheRow
    | undefined;
  if (!row) return null;
  db.prepare('UPDATE cache SET last_access = ? WHERE key = ?').run(
    Date.now(),
    key
  );
  return { content: row.content, fingerprint: rowToFingerprint(row) };
}

export function cacheDelete(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM cache WHERE key = ?').run(key);
}

export function cacheStats(
  dbPathOrDb: string | Database.Database,
  opts: CacheOptions = {}
): CacheStats {
  const capacity = opts.capacityBytes ?? DEFAULT_CAPACITY_BYTES;
  const db =
    typeof dbPathOrDb === 'string' ? new Database(dbPathOrDb, { readonly: true }) : dbPathOrDb;
  const row = db
    .prepare(
      'SELECT COUNT(*) as count, COALESCE(SUM(size), 0) as total, MIN(last_access) as oldest FROM cache'
    )
    .get() as { count: number; total: number; oldest: number | null };
  return {
    totalSize: row.total,
    entryCount: row.count,
    oldestAccess: row.oldest ?? 0,
    capacityBytes: capacity,
  };
}

interface CacheRow {
  key: string;
  content: string;
  hash: string;
  version: number;
  confidence: number;
  size: number;
  updated_at: number;
  last_access: number;
}

function rowToFingerprint(row: CacheRow): Fingerprint {
  return {
    hash: row.hash,
    version: row.version,
    confidence: row.confidence,
    size: row.size,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function evictIfNeeded(db: Database.Database, capacity: number): void {
  const total = (
    db.prepare('SELECT COALESCE(SUM(size), 0) as total FROM cache').get() as {
      total: number;
    }
  ).total;
  if (total <= capacity) return;
  const overage = total - capacity;
  let evictedSize = 0;
  const rows = db
    .prepare(
      'SELECT key, size FROM cache ORDER BY last_access ASC'
    )
    .all() as { key: string; size: number }[];
  for (const r of rows) {
    if (evictedSize >= overage) break;
    db.prepare('DELETE FROM cache WHERE key = ?').run(r.key);
    evictedSize += r.size;
    console.log(
      `[cache] evicted ${r.key} (${r.size} bytes) — over capacity`
    );
  }
}
