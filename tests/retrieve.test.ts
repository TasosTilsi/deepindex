import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { tokenize, tfidf, retrieve, DEFAULT_TOP_K } from '../src/retrieve.js';
import type Database from 'better-sqlite3';

describe('retrieve', () => {
  describe('tokenize', () => {
    it('lowercases, splits on non-alphanum, dedupes, drops length<=1', () => {
      const t = tokenize('getUser ById_v2 alpha!beta');
      // getuserbyid is a single token because ById is followed by _v2 (no separator
      // between ById and _v2 from the perspective of letters; the regex split on
      // [^a-z0-9_]+ sees ById_v2 as a single contiguous a-z0-9_ string after
      // lowercasing).
      // Actually: lowercased = "getuser byid_v2 alpha!beta"
      // splits on [^a-z0-9_]+ → ["getuser", "byid_v2", "alpha", "beta"]
      // length>1 + dedupe.
      expect(t).toEqual(['getuser', 'byid_v2', 'alpha', 'beta']);
    });

    it('empty input -> []', () => {
      expect(tokenize('')).toEqual([]);
    });
  });

  describe('tfidf', () => {
    it('computes smoothed tfidf with no NaN on df=0', () => {
      const docs = [['auth', 'login'], ['unrelated']];
      const scores = tfidf(['auth'], docs);
      // doc 0: tf=1 → (1+log(1)) = 1; df=1, N=2 → idf = log(1 + 2/(1+1)) = log(2)
      // score = 1 * log(2) ≈ 0.6931
      expect(scores[0]).toBeCloseTo(Math.log(2), 5);
      // doc 1: token not present
      expect(scores[1]).toBe(0);
    });

    it('handles a token missing from all docs without NaN', () => {
      const scores = tfidf(['nonexistent'], [['a', 'b'], ['c', 'd']]);
      expect(scores.every((s) => Number.isFinite(s))).toBe(true);
      expect(scores.every((s) => s === 0)).toBe(true);
    });
  });

  describe('retrieve', () => {
    let db: Database.Database;
    let tmpDir: string;

    beforeAll(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ctx-retrieve-'));
      const dbPath = join(tmpDir, 'test.db');
      db = initDb(dbPath);
      // Build a 3-file corpus: A (seed) imports B (depth 1) imports C (depth 2)
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at)
               VALUES ('a.ts', 'h1', 1, 1, 'ts', 1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at)
               VALUES ('b.ts', 'h2', 1, 1, 'ts', 1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at)
               VALUES ('c.ts', 'h3', 1, 1, 'ts', 1)`);
      const a = db.prepare(`SELECT id FROM files WHERE path = 'a.ts'`).get() as { id: number };
      const b = db.prepare(`SELECT id FROM files WHERE path = 'b.ts'`).get() as { id: number };
      const c = db.prepare(`SELECT id FROM files WHERE path = 'c.ts'`).get() as { id: number };
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'authenticate', 'function', 1, 2, 1)`).run(a.id);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'helper', 'function', 1, 2, 1)`).run(b.id);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'utility', 'function', 1, 2, 1)`).run(c.id);
      const sa = db.prepare(`SELECT id FROM symbols WHERE name = 'authenticate'`).get() as { id: number };
      const sh = db.prepare(`SELECT id FROM symbols WHERE name = 'helper'`).get() as { id: number };
      const su = db.prepare(`SELECT id FROM symbols WHERE name = 'utility'`).get() as { id: number };
      // A imports B (so helper is dependent of authenticate's file via edge).
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sa.id, sh.id);
      // B imports C.
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sh.id, su.id);
    });

    afterAll(() => {
      closeDb();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('top result for query "auth" is the seed file (a.ts)', () => {
      const r = retrieve(db, 'auth', { topK: 3 });
      expect(r.length).toBeGreaterThan(0);
      // Top 3 includes a.ts, b.ts, c.ts.
      const paths = r.map((h) => h.path);
      expect(paths).toContain('a.ts');
      expect(r[0].path).toBe('a.ts');
      // Has auth-related symbol in top-3.
      const top3HasAuth = r.slice(0, 3).some((h) =>
        h.symbols.some((s) => s.name.toLowerCase().includes('auth'))
      );
      expect(top3HasAuth).toBe(true);
    });

    it('payload contains path/score/symbols/summary and no body/content', () => {
      const r = retrieve(db, 'auth');
      expect(r.length).toBeGreaterThan(0);
      const keys = Object.keys(r[0]).sort().join(',');
      expect(keys).toBe('path,score,summary,symbols');
    });

    it('empty DB -> []', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-retrieve-empty-'));
      const localDb = initDb(join(dir, 'test.db'));
      expect(retrieve(localDb, 'anything')).toEqual([]);
      localDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('non-matching query returns [] (no seeds found)', () => {
      const r = retrieve(db, 'zzzzz_definitely_no_match', { topK: 10 });
      expect(r.length).toBe(0);
    });

    it('default topK is 10', () => {
      expect(DEFAULT_TOP_K).toBe(10);
    });
  });
});
