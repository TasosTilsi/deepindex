import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { buildCorpus } from '../src/semantic/knowledge.js';
import { embed } from '../src/semantic/embed.js';
import { MODEL_CONFIGS, type Embedder } from '../src/semantic/embedder.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

/** Deterministic fake embedder: vectors derived from a hash of the text
 *  (D-24b — CI never touches a native model). */
function fakeVec(text: string): number[] {
  const h = createHash('sha256').update(text).digest();
  const v = Array.from({ length: 384 }, (_, i) => (h[i % h.length]! / 255) - 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function fakeEmbedder(model = 'fake'): Embedder {
  return {
    model,
    dim: 384,
    embed: async (texts) => texts.map(fakeVec),
  };
}

describe('semantic embed lifecycle (hash guard + file-scoped re-embed)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-embed-'));
  const dbPath = join(tmpDir, 'test.db');
  const fixtureCopy = join(tmpDir, 'repo');
  let db: Database.Database;

  beforeAll(async () => {
    cpSync(FIXTURE, fixtureCopy, { recursive: true });
    db = initDb(dbPath);
    await buildGraph(db, fixtureCopy);
    // Seed one entity so the entity corpus kind is exercised (the fixture
    // copy carries no git history — same pattern as semantic-knowledge.test).
    db.prepare(
      `INSERT INTO entities (id, type, name, content) VALUES ('e-seed', 'decision', 'seed entity', 'seeded for embed test')`
    ).run();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (e) Disabled-degradation branch THROUGH THE F-3 SEAM — runs first so the
  // shared db has never had vec tables created: a bogus loadable path forces
  // the same code path a real missing-extension failure takes (checker F-3,
  // RSK-4). Must return an EmbedResult without throwing, embedded 0, vec
  // tables absent from sqlite_master.
  it('embed with a bogus vecLoadablePath degrades: no throw, embedded 0, vec tables untouched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await embed(db, {
        rootDir: fixtureCopy,
        embedder: fakeEmbedder(),
        vecLoadablePath: join(tmpdir(), 'no-such-vec-ext'),
      });
      expect(res.embedded).toBe(0);
      expect(res.corpusCounts.entity).toBeGreaterThan(0);
      const names = (
        db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]
      ).map((r) => r.name);
      expect(names).not.toContain('entity_vecs');
      expect(names).not.toContain('symbol_vecs');
      expect(names).not.toContain('doc_vecs');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('embed:'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  // (a) EMBD-01: embed populates every corpus kind; embeddings_meta covers
  // entity/symbol/module/doc.
  it('embed embeds the full corpus and records all four kinds', async () => {
    const res = await embed(db, { rootDir: fixtureCopy, embedder: fakeEmbedder() });
    const corpus = buildCorpus(db, fixtureCopy);
    expect(res.embedded).toBe(corpus.length);
    expect(res.skipped).toBe(0);
    expect(res.model).toBe(MODEL_CONFIGS.minilm.name);
    expect(res.dim).toBe(384);
    const kinds = (
      db.prepare('SELECT DISTINCT kind FROM embeddings_meta').all() as { kind: string }[]
    ).map((r) => r.kind);
    expect(new Set(kinds)).toEqual(new Set(['entity', 'symbol', 'module', 'doc']));
    // Vec tables now exist and hold one row per meta entry.
    const vecRows = (
      db.prepare(
        `SELECT (SELECT COUNT(*) FROM entity_vecs) + (SELECT COUNT(*) FROM symbol_vecs) + (SELECT COUNT(*) FROM doc_vecs) c`
      ).get() as { c: number }
    ).c;
    expect(vecRows).toBe(corpus.length);
  });

  // (b) EMBD-01 acceptance: immediate rerun embeds 0 (hash guard, POC
  // invariant).
  it('rerun with no changes embeds 0', async () => {
    const res = await embed(db, { rootDir: fixtureCopy, embedder: fakeEmbedder() });
    expect(res.embedded).toBe(0);
    expect(res.skipped).toBeGreaterThan(0);
  });

  // (c) EMBD-05 acceptance: mutating one fixture file re-embeds only that
  // file's docs — every re-embedded meta row carries that file's source_path.
  it('mutating one file re-embeds only that file\u2019s docs (file-scoped)', async () => {
    const before = new Map(
      (
        db
          .prepare('SELECT kind, doc_id, vec_rowid, embedded_at FROM embeddings_meta')
          .all() as { kind: string; doc_id: string; vec_rowid: number; embedded_at: number }[]
      ).map((r) => [`${r.kind}:${r.doc_id}`, r.embedded_at])
    );
    appendFileSync(join(fixtureCopy, 'src', 'a.ts'), '\n// mutation marker\n');
    await buildGraph(db, fixtureCopy); // incremental hash-diff rebuild

    const res = await embed(db, { rootDir: fixtureCopy, embedder: fakeEmbedder() });
    expect(res.embedded).toBeGreaterThan(0);
    expect(res.skipped).toBeGreaterThan(0);

    const after = db
      .prepare('SELECT kind, doc_id, source_path, embedded_at FROM embeddings_meta')
      .all() as { kind: string; doc_id: string; source_path: string | null; embedded_at: number }[];
    const reembedded = after.filter(
      (r) => before.get(`${r.kind}:${r.doc_id}`) !== r.embedded_at
    );
    expect(reembedded.length).toBe(res.embedded);
    for (const r of reembedded) {
      expect(r.source_path).toBe('src/a.ts');
    }
  });

  // (d) D-21b: model mismatch against embeddings_meta → warning + full
  // re-embed, never silent reuse.
  it('model mismatch warns and re-embeds every doc', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const res = await embed(db, {
        rootDir: fixtureCopy,
        embedder: fakeEmbedder('other-model'),
        model: 'other-model',
      });
      const corpus = buildCorpus(db, fixtureCopy);
      expect(res.embedded).toBe(corpus.length);
      expect(res.model).toBe('other-model');
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes('mismatch'))
      ).toBe(true);
      const stale = db
        .prepare(`SELECT COUNT(*) c FROM embeddings_meta WHERE model = 'fake'`)
        .get() as { c: number };
      expect(stale.c).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  // stalenessScan is pure — never loads the model, reports stale docs with
  // their source paths (D-26c substrate).
  it('stalenessScan reports nothing stale after a clean embed without loading a model', async () => {
    const { embed: embedAgain } = await import('../src/semantic/embed.js');
    await embedAgain(db, { rootDir: fixtureCopy, embedder: fakeEmbedder() });
    const { stalenessScan } = await import('../src/semantic/embed.js');
    const scan = stalenessScan(db, fixtureCopy);
    expect(scan.stale.length).toBe(0);
    expect(scan.corpusCounts.entity).toBeGreaterThan(0);
    expect(scan.corpusCounts.symbol).toBeGreaterThan(0);
    expect(scan.corpusCounts.module).toBeGreaterThan(0);
    expect(scan.corpusCounts.doc).toBeGreaterThan(0);
  });
});