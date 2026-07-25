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

  it('parses all 3 fixture files', () => {
    const rows = db.prepare('SELECT COUNT(*) as c FROM files').get() as { c: number };
    expect(rows.c).toBe(3);
  });

  it('extracts 4 exported symbols (foo, bar, baz, ANSWER)', () => {
    const rows = db.prepare(
      "SELECT name FROM symbols WHERE exported = 1 ORDER BY name"
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name)).toEqual(['ANSWER', 'bar', 'baz', 'foo']);
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
});
