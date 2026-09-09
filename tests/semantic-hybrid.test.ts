import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { ensureVecTables } from '../src/semantic/vec.js';
import { embed } from '../src/semantic/embed.js';
import {
  hybridSearch,
  rrfFuse,
  type HybridHit,
} from '../src/semantic/search-hybrid.js';
import { searchEntities } from '../src/git/search.js';
import { MODEL_CONFIGS, type Embedder } from '../src/semantic/embedder.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');
const TOML = '[semantic]\nenabled = true\n';

/** Topic-lexicon fake embedder (D-24b — CI never touches a native model).
 *  Each topic maps to one vector dimension; a text's vector is the normalized
 *  sum of one-hot topic hits. Synonyms share a topic, so a query can rank a
 *  doc whose text shares NO lexical token with the query — the paraphrase
 *  property SRSR-01 demands, deterministically. */
const TOPICS: Record<string, number> = {
  storage: 0,
  cache: 0,
  database: 0,
  persist: 0,
  persistent: 0,
  durable: 0,
  durability: 0,
  auth: 1,
  token: 1,
  session: 1,
  login: 1,
  network: 2,
  http: 2,
  retry: 2,
  timeout: 2,
};

function topicVec(text: string): number[] {
  const v = new Array<number>(384).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z]+/)) {
    const t = TOPICS[tok];
    if (t !== undefined) v[t] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function topicEmbedder(model = 'fake'): Embedder {
  return { model, dim: 384, embed: async (texts) => texts.map(topicVec) };
}

function loaderSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(async (m: string) => topicEmbedder(m));
}

describe('hybrid search (RRF fusion + typed sourced hits)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-hybrid-'));
  const fixtureCopy = join(tmpDir, 'repo');
  let db: Database.Database;

  beforeAll(async () => {
    cpSync(FIXTURE, fixtureCopy, { recursive: true });
    db = initDb(join(tmpDir, 'test.db'));
    await buildGraph(db, fixtureCopy);
    // Seeded entities (fixture copy has no git index): one paraphrase target
    // (name shares no token with its query) and one FTS-matchable entity.
    db.prepare(
      `INSERT INTO entities (id, type, name, content)
       VALUES ('e-para', 'decision', 'atlas', 'persistent cache layer')`
    ).run();
    db.prepare(
      `INSERT INTO entities (id, type, name, content)
       VALUES ('e-auth', 'decision', 'auth gateway', 'auth token handling')`
    ).run();
    await embed(db, { rootDir: fixtureCopy, embedder: topicEmbedder() });
    writeFileSync(join(fixtureCopy, '.deepindex.toml'), TOML);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) Byte-identical degradation pin (OQ-8/RSK-8): lexical mode returns the
  // searchEntities array VERBATIM.
  it('mode lexical is byte-identical to searchEntities', async () => {
    const q = 'auth';
    const viaHybrid = await hybridSearch(db, q, { mode: 'lexical', limit: 10 });
    expect(JSON.stringify(viaHybrid)).toBe(JSON.stringify(searchEntities(db, q, 10)));
  });

  // (b) RSK-6/SRSR-04 pin: the same rowid VALUE in two vec tables never
  // cross-maps — each (kind, vec_rowid) resolves to its own doc.
  it('(kind, vec_rowid) mapping survives a rowid collision across vec tables', async () => {
    const db2 = initDb(join(tmpDir, 'collision.db'));
    try {
      expect(ensureVecTables(db2).ok).toBe(true);
      db2
        .prepare(`INSERT INTO files (path, hash, mtime, size) VALUES ('src/x.ts', 'h', 1, 10)`)
        .run();
      db2
        .prepare(
          `INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported)
           VALUES (1, 'collider', 'function', 1, 2, 1)`
        )
        .run();
      db2
        .prepare(
          `INSERT INTO entities (id, type, name, content)
           VALUES ('e-coll', 'decision', 'collider', 'persistent cache layer')`
        )
        .run();
      // Both tables are empty → first insert lands on rowid 1 in EACH — a
      // natural rowid collision across tables.
      const buf = Buffer.from(new Float32Array(topicVec('database durability')).buffer);
      db2.prepare('INSERT INTO entity_vecs(embedding) VALUES (?)').run(buf);
      db2.prepare('INSERT INTO symbol_vecs(embedding) VALUES (?)').run(buf);
      db2
        .prepare(
          `INSERT INTO embeddings_meta (kind, doc_id, vec_rowid, hash, model, dim, source_path, embedded_at)
           VALUES ('entity', 'e-coll', 1, 'h', 'm', 384, NULL, 1),
                  ('symbol', 'sym:1', 1, 'h', 'm', 384, 'src/x.ts', 1)`
        )
        .run();
      const hits = (await hybridSearch(db2, 'database durability', {
        mode: 'semantic',
        repoPath: fixtureCopy,
        embedder: topicEmbedder(),
      })) as HybridHit[];
      const entityHit = hits.find((h) => h.kind === 'entity' && h.id === 'e-coll');
      const symbolHit = hits.find((h) => h.kind === 'symbol' && h.id === 'sym:1');
      expect(entityHit).toBeDefined();
      expect(symbolHit).toBeDefined();
      expect(entityHit!.score).toBeCloseTo(1.0, 5);
      expect(symbolHit!.score).toBeCloseTo(1.0, 5);
      expect(entityHit!.source).toBe('vec');
    } finally {
      db2.close();
    }
  });

  // (c) Paraphrase acceptance (SRSR-01): the query shares no token with the
  // entity NAME, lexical mode misses it, semantic mode ranks it first.
  it('semantic mode returns the paraphrase target lexical mode misses', async () => {
    const q = 'database durability';
    const lex = await hybridSearch(db, q, { mode: 'lexical', limit: 10 });
    expect(JSON.stringify(lex)).toBe(JSON.stringify(searchEntities(db, q, 10)));
    expect((lex as HybridHit[]).some((h) => h.id === 'e-para')).toBe(false);
    const sem = (await hybridSearch(db, q, {
      mode: 'semantic',
      limit: 10,
      repoPath: fixtureCopy,
      embedder: topicEmbedder(),
    })) as HybridHit[];
    expect(sem[0]).toMatchObject({ kind: 'entity', id: 'e-para', source: 'vec' });
  });

  // (d) All three provenances in one hybrid run + the RRF ceiling: fused
  // scores are RRF sums (≤ 3/61), never cosine-scale (< 0.35) — the property
  // UI-SPEC U-1 protects.
  it('hybrid run carries lexical/vec/graph sources with RRF-scale scores', async () => {
    const hits = (await hybridSearch(db, 'auth', {
      mode: 'hybrid',
      limit: 10,
      repoPath: fixtureCopy,
      embedder: topicEmbedder(),
    })) as HybridHit[];
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.score).toBeLessThanOrEqual(3 / 61 + 1e-9);
      expect(h.score).toBeLessThan(0.35);
    }
    expect(
      hits.some((h) => h.source === 'lexical' && h.kind === 'entity' && h.id === 'e-auth')
    ).toBe(true);
    expect(hits.some((h) => h.source === 'vec' && h.kind === 'symbol')).toBe(true);
    expect(
      hits.some(
        (h) => h.source === 'graph' && h.kind === 'file' && h.path === 'src/with-comments.ts'
      )
    ).toBe(true);
  });

  // (e) rrfFuse unit: exact 1/(60+rank) sums and deterministic tie-break.
  it('rrfFuse sums 1/(60+rank) per list and breaks ties deterministically', () => {
    const a: HybridHit = { kind: 'entity', id: 'a', label: 'a', score: 0, source: 'lexical' };
    const b: HybridHit = { kind: 'entity', id: 'b', label: 'b', score: 0, source: 'lexical' };
    const c: HybridHit = { kind: 'file', id: 'c', label: 'c', score: 0, source: 'graph' };
    const fused = rrfFuse([[{ hit: a }, { hit: b }], [{ hit: c }, { hit: b }]]);
    // b: rank 2 in both lists → 1/62 + 1/62; a and c: rank 1 → 1/61 each.
    expect(fused.map((h) => h.id)).toEqual(['b', 'a', 'c']);
    expect(fused[0]!.score).toBeCloseTo(2 / 62, 12);
    expect(fused[1]!.score).toBeCloseTo(1 / 61, 12);
    expect(fused[2]!.score).toBeCloseTo(1 / 61, 12);
  });

  // (f) CONFIG-AWARE SEARCH MODEL (D-24): [semantic].model selects the search
  // embedder through the same shared resolver embed() uses; opts.embedder
  // still wins over the loader when injected.
  it('semantic mode resolves the embedder model from [semantic] config', async () => {
    const tomlPath = join(fixtureCopy, '.deepindex.toml');
    writeFileSync(tomlPath, '[semantic]\nenabled = true\nmodel = bge\n');
    const bgeLoader = loaderSpy();
    await hybridSearch(db, 'auth', {
      mode: 'semantic',
      repoPath: fixtureCopy,
      loader: bgeLoader,
    });
    expect(bgeLoader).toHaveBeenCalledTimes(1);
    expect(bgeLoader.mock.calls[0]![0]).toBe(MODEL_CONFIGS.bge.name);

    writeFileSync(tomlPath, TOML); // no model key → minilm default
    const minilmLoader = loaderSpy();
    await hybridSearch(db, 'auth', {
      mode: 'semantic',
      repoPath: fixtureCopy,
      loader: minilmLoader,
    });
    expect(minilmLoader.mock.calls[0]![0]).toBe(MODEL_CONFIGS.minilm.name);

    const loaderNotCalled = loaderSpy();
    await hybridSearch(db, 'auth', {
      mode: 'semantic',
      repoPath: fixtureCopy,
      embedder: topicEmbedder(),
      loader: loaderNotCalled,
    });
    expect(loaderNotCalled).not.toHaveBeenCalled();
  });
});