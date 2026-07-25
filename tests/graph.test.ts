import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { getSymbolByName, getDependencies, getDependents } from '../src/graph/query.js';
import type Database from 'better-sqlite3';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('graph layer', () => {
  let db: Database.Database;
  let tmpDir: string;
  let dbPath: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-test-'));
    dbPath = join(tmpDir, 'test.db');
    db = initDb(dbPath);
    await buildGraph(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses all fixture files', () => {
    const rows = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    // Phase 2 added: src/with-comments.ts, src/thread-counter.ts, and
    // outdated-doc.ts at the repo root. Original 3 (a/b/c.ts) + 3 new = 6.
    expect(rows.c).toBe(6);
  });

  it('extracts exported symbols including the phase 2 additions', () => {
    const rows = db.prepare(
      "SELECT name FROM symbols WHERE exported = 1 ORDER BY name"
    ).all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain('ANSWER');
    expect(names).toContain('bar');
    expect(names).toContain('baz');
    expect(names).toContain('foo');
    // Phase 2 additions:
    expect(names).toContain('WORKER_THREADS');
    expect(names).toContain('auth');
    expect(names).toContain('countThreads');
  });

  it('detects broken import (c.ts imports ./missing)', () => {
    const rows = db.prepare(
      "SELECT source FROM imports WHERE resolved = 0"
    ).all() as { source: string }[];
    expect(rows.some((r) => r.source === './missing')).toBe(true);
  });

  it('BFS: foo depends on bar (depth 1)', () => {
    const foo = getSymbolByName(db, 'foo')[0];
    expect(foo).toBeDefined();
    const deps = getDependencies(db, foo.id, 1);
    const depNames = deps.map((id) => getSymbolByName(db, '').length || id);
    const directDeps = db.prepare(
      `SELECT s.name FROM edges e JOIN symbols s ON s.id = e.to_symbol_id
       WHERE e.from_symbol_id = ?`
    ).all(foo.id) as { name: string }[];
    const names = directDeps.map((r) => r.name);
    expect(names).toContain('bar');
  });

  it('BFS: foo transitively reaches baz (depth 2)', () => {
    const foo = getSymbolByName(db, 'foo')[0];
    const deps = getDependencies(db, foo.id, 2);
    const ids = new Set(deps);
    const bazRows = getSymbolByName(db, 'baz');
    expect(bazRows.some((b) => ids.has(b.id))).toBe(true);
  });

  it('BFS: bar is a dependent of foo (who imports foo?) — no one, so empty', () => {
    const foo = getSymbolByName(db, 'foo')[0];
    const dependents = getDependents(db, foo.id, 5);
    expect(dependents.length).toBe(0);
  });

  it('BFS: baz has dependent bar (bar imports from c.ts)', () => {
    const baz = getSymbolByName(db, 'baz')[0];
    const dependents = getDependents(db, baz.id, 1);
    const ids = new Set(dependents);
    const barRows = getSymbolByName(db, 'bar');
    expect(barRows.some((b) => ids.has(b.id))).toBe(true);
  });

  // GRPH-02: hash-based invalidation
  it('rebuild on unchanged files is a no-op (no re-parse)', async () => {
    const before = db
      .prepare('SELECT path, hash, parsed_at FROM files')
      .all() as { path: string; hash: string; parsed_at: number }[];
    const beforeSnap = new Map(before.map((r) => [r.path, r.hash + ':' + r.parsed_at]));

    // Build again on the same fixture → all hashes match → 0 files re-parsed
    await buildGraph(db, FIXTURE);

    const after = db
      .prepare('SELECT path, hash, parsed_at FROM files')
      .all() as { path: string; hash: string; parsed_at: number }[];
    expect(after.length).toBe(before.length);
    for (const row of after) {
      const prev = beforeSnap.get(row.path);
      expect(prev).toBeDefined();
      expect(row.hash + ':' + row.parsed_at).toBe(prev);
    }
  });

  it('rebuild after one file change re-parses only that file', async () => {
    const cPath = join(FIXTURE, 'src/c.ts');
    const original = require('node:fs').readFileSync(cPath, 'utf8');
    try {
      require('node:fs').writeFileSync(cPath, original + '\n// touched\n');
      const before = db
        .prepare('SELECT path, hash FROM files')
        .all() as { path: string; hash: string }[];
      const cBefore = before.find((r) => r.path === 'src/c.ts')!;
      const aBefore = before.find((r) => r.path === 'src/a.ts')!;
      const bBefore = before.find((r) => r.path === 'src/b.ts')!;

      await buildGraph(db, FIXTURE);

      const after = db
        .prepare('SELECT path, hash FROM files')
        .all() as { path: string; hash: string }[];
      const cAfter = after.find((r) => r.path === 'src/c.ts')!;
      const aAfter = after.find((r) => r.path === 'src/a.ts')!;
      const bAfter = after.find((r) => r.path === 'src/b.ts')!;

      // c.ts hash changed
      expect(cAfter.hash).not.toBe(cBefore.hash);
      // a.ts and b.ts unchanged
      expect(aAfter.hash).toBe(aBefore.hash);
      expect(bAfter.hash).toBe(bBefore.hash);
    } finally {
      require('node:fs').writeFileSync(cPath, original);
      // Rebuild to restore hashes
      await buildGraph(db, FIXTURE);
    }
  });
});
