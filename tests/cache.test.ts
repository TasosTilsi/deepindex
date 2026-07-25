import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { cacheSet, cacheGet, cacheDelete, cacheStats } from '../src/cache.js';
import { sha256 } from '../src/fingerprint.js';
import type Database from 'better-sqlite3';

describe('cache layer', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-cache-'));
    db = initDb(join(tmpDir, 'cache.db'));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('set + get round-trips content and fingerprint', () => {
    const fp = cacheSet(db, 'k1', 'hello world');
    const got = cacheGet(db, 'k1');
    expect(got).not.toBeNull();
    expect(got!.content).toBe('hello world');
    expect(got!.fingerprint.hash).toBe(sha256('hello world'));
    expect(got!.fingerprint.version).toBe(1);
    expect(fp.size).toBe('hello world'.length);
  });

  it('re-storing same content returns same version + hash (no-op)', () => {
    const fp1 = cacheSet(db, 'k2', 'same content');
    const fp2 = cacheSet(db, 'k2', 'same content');
    expect(fp2.version).toBe(fp1.version);
    expect(fp2.hash).toBe(sha256('same content'));
  });

  it('re-storing mutated content yields new hash, version 2', () => {
    cacheSet(db, 'k3', 'v1');
    const fp = cacheSet(db, 'k3', 'v2 mutated');
    expect(fp.hash).toBe(sha256('v2 mutated'));
    expect(fp.version).toBe(2);
  });

  it('delete removes entry', () => {
    cacheSet(db, 'k4', 'doomed');
    cacheDelete(db, 'k4');
    expect(cacheGet(db, 'k4')).toBeNull();
  });

  it('LRU eviction when capacity exceeded', () => {
    const small = initDb2(join(tmpDir, 'small.db'), 100); // 100 byte cap
    cacheSet(small, 'a', 'x'.repeat(30), { capacityBytes: 100 });
    // ms-resolution last_access — distinct inserts need distinct timestamps
    const wait = (ms: number) =>
      new Promise<void>((r) => setTimeout(r, ms));
    return wait(2)
      .then(() => cacheSet(small, 'b', 'y'.repeat(30), { capacityBytes: 100 }))
      .then(() => wait(2))
      .then(() => cacheSet(small, 'c', 'z'.repeat(30), { capacityBytes: 100 }))
      .then(() => cacheGet(small, 'a')) // touch a
      .then(() =>
        cacheSet(small, 'd', 'w'.repeat(30), { capacityBytes: 100 })
      )
      .then(() => {
        expect(cacheGet(small, 'a')).not.toBeNull();
        expect(cacheGet(small, 'b')).toBeNull();
      });
  });

  it('stats reports entry count and total size', () => {
    const stats = cacheStats(db);
    expect(stats.entryCount).toBeGreaterThan(0);
    expect(stats.totalSize).toBeGreaterThan(0);
    expect(stats.capacityBytes).toBe(100 * 1024 * 1024);
  });
});

// helper to create a second db in same dir
function initDb2(path: string, _ignored: number): Database.Database {
  return initDb(path);
}
