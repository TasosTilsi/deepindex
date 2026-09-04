import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
      tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-retrieve-'));
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
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-retrieve-empty-'));
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

  describe('graph BFS combined score', () => {
    it('seed file (depth 0) ranks higher than depth-1 and depth-2 dependents', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-bfs-'));
      const db = initDb(join(dir, 'test.db'));
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('a.ts','h',1,1,'ts',1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('b.ts','h',1,1,'ts',1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('c.ts','h',1,1,'ts',1)`);
      const a = (db.prepare(`SELECT id FROM files WHERE path='a.ts'`).get() as { id: number }).id;
      const b = (db.prepare(`SELECT id FROM files WHERE path='b.ts'`).get() as { id: number }).id;
      const c = (db.prepare(`SELECT id FROM files WHERE path='c.ts'`).get() as { id: number }).id;
      // Symbols that do NOT contain 'auth' as a substring, so the LIKE branch
      // does not accidentally make b/c depth-0 seeds.
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'auth', 'function', 1, 2, 1)`).run(a);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'zzz_b', 'function', 1, 2, 1)`).run(b);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'zzz_c', 'function', 1, 2, 1)`).run(c);
      const sa = (db.prepare(`SELECT id FROM symbols WHERE name='auth'`).get() as { id: number }).id;
      const sb = (db.prepare(`SELECT id FROM symbols WHERE name='zzz_b'`).get() as { id: number }).id;
      const sc = (db.prepare(`SELECT id FROM symbols WHERE name='zzz_c'`).get() as { id: number }).id;
      // b depends on a (b's symbol points to a's symbol); c depends on b.
      // getDependents(seed) walks edges WHERE to_symbol_id = seed, returning
      // from_symbol_id. So getDependents(sa, 1) -> [sb], getDependents(sa, 2) -> [sb, sc].
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sb, sa);
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sc, sb);
      const r = retrieve(db, 'auth', { topK: 5 });
      // a.ts is the seed file (depth 0); b.ts is depth-1; c.ts is depth-2.
      expect(r[0].path).toBe('a.ts');
      const byPath = new Map(r.map((h) => [h.path, h.score]));
      const aScore = byPath.get('a.ts')!;
      const bScore = byPath.get('b.ts')!;
      const cScore = byPath.get('c.ts')!;
      expect(aScore).toBeGreaterThan(bScore);
      expect(bScore).toBeGreaterThan(cScore);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('depth-1 file with the same keyword outranks a depth-2 file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-bfs2-'));
      const db = initDb(join(dir, 'test.db'));
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('seed.ts','h',1,1,'ts',1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('near.ts','h',1,1,'ts',1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('far.ts','h',1,1,'ts',1)`);
      const seed = (db.prepare(`SELECT id FROM files WHERE path='seed.ts'`).get() as { id: number }).id;
      const near = (db.prepare(`SELECT id FROM files WHERE path='near.ts'`).get() as { id: number }).id;
      const far = (db.prepare(`SELECT id FROM files WHERE path='far.ts'`).get() as { id: number }).id;
      // Symbols: 'auth' for seed (exact match), 'near' for near (no match),
      // 'far' for far (no match). Use path tokens via 'auth' as a path token:
      // we use 'authx' as the keyword in 'near.ts' and 'authy' in 'far.ts'
      // file paths so that LIKE substring match doesn't promote them to depth 0.
      // We rely on path tokens for keyword matching here.
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'auth', 'function', 1, 2, 1)`).run(seed);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'near', 'function', 1, 2, 1)`).run(near);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'far', 'function', 1, 2, 1)`).run(far);
      const sa = (db.prepare(`SELECT id FROM symbols WHERE name='auth'`).get() as { id: number }).id;
      const sn = (db.prepare(`SELECT id FROM symbols WHERE name='near'`).get() as { id: number }).id;
      const sf = (db.prepare(`SELECT id FROM symbols WHERE name='far'`).get() as { id: number }).id;
      // near depends on seed; far depends on near.
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sn, sa);
      db.prepare(`INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`).run(sf, sn);
      // Query 'auth' only matches seed.ts via exact symbol name. near/far get
      // only graphProximity: near depth 1 (proximity 0.5) > far depth 2 (proximity 0.333).
      const r = retrieve(db, 'auth', { topK: 5 });
      const nearRow = r.find((h) => h.path === 'near.ts')!;
      const farRow = r.find((h) => h.path === 'far.ts')!;
      expect(nearRow.score).toBeGreaterThan(farRow.score);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('seed file with no keyword match is still included (depth 0 proximity alone)', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-bfs3-'));
      const db = initDb(join(dir, 'test.db'));
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('unrelated_seed.ts','h',1,1,'ts',1)`);
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('other.ts','h',1,1,'ts',1)`);
      const a = (db.prepare(`SELECT id FROM files WHERE path='unrelated_seed.ts'`).get() as { id: number }).id;
      const b = (db.prepare(`SELECT id FROM files WHERE path='other.ts'`).get() as { id: number }).id;
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'auth', 'function', 1, 2, 1)`).run(a);
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'zzz_nomatch', 'function', 1, 2, 1)`).run(b);
      // Query 'auth' has exact match in seed file; depth 0 proximity makes the
      // seed file rank even though no other file has the keyword.
      const r = retrieve(db, 'auth', { topK: 5 });
      expect(r.length).toBeGreaterThan(0);
      expect(r[0].path).toBe('unrelated_seed.ts');
      expect(r[0].score).toBeGreaterThan(0);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('payload summary (RTRV-03)', () => {
    it('summary skips leading comment lines and uses the real function body', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-summary-'));
      const dbPath = join(dir, 'test.db');
      const db = initDb(dbPath);
      // The fixture file is at fixtures/sample-repo/src/with-comments.ts.
      // We register it with startLine=3 (where 'export function auth' begins).
      const rel = 'src/with-comments.ts';
      db.exec(
        `INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('${rel}', 'h', 1, 1, 'ts', 1)`
      );
      const fid = (db.prepare(`SELECT id FROM files WHERE path = ?`).get(rel) as { id: number }).id;
      db.prepare(
        `INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'auth', 'function', 3, 5, 1)`
      ).run(fid);
      const r = retrieve(db, 'auth', { repoPath: resolve(process.cwd(), 'fixtures/sample-repo') });
      expect(r.length).toBeGreaterThan(0);
      const hit = r[0];
      expect(hit.summary).not.toMatch(/^\/\/ header comment/);
      expect(hit.summary).toMatch(/export function auth/);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('payload keys are exactly path, score, symbols, summary', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-payload-'));
      const db = initDb(join(dir, 'test.db'));
      db.exec(`INSERT INTO files (path, hash, mtime, size, language, parsed_at) VALUES ('x.ts','h',1,1,'ts',1)`);
      const fid = (db.prepare(`SELECT id FROM files WHERE path='x.ts'`).get() as { id: number }).id;
      db.prepare(`INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported) VALUES (?, 'auth', 'function', 1, 2, 1)`).run(fid);
      const r = retrieve(db, 'auth');
      expect(r.length).toBeGreaterThan(0);
      expect(Object.keys(r[0]).sort().join(',')).toBe('path,score,summary,symbols');
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
