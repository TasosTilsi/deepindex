import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDb, closeDb } from '../src/graph/db.js';
import { ensureVecTables, vecSearch, deleteVecRow } from '../src/semantic/vec.js';
import { SemanticUnavailableError, MODEL_CONFIGS } from '../src/semantic/embedder.js';

describe('semantic vec layer (schema v6 + lazy vec0)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-vec-'));
  const dbPath = join(tmpDir, 'test.db');
  const db = initDb(dbPath);
  let vecRowid: number;
  let queryVec: number[];

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) Pin: initDb NEVER requires the extension — readonly watcher/serve
  // connections open a v6 db and never touch vec0 tables (RSK-2).
  it('initDb creates embeddings_meta but no vec0 tables', () => {
    const names = (
      db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain('embeddings_meta');
    expect(names).not.toContain('entity_vecs');
    expect(names).not.toContain('symbol_vecs');
    expect(names).not.toContain('doc_vecs');
    const v = db.pragma('user_version', { simple: true }) as number;
    expect(v).toBe(6);
  });

  // (b) Lazy creation loads the extension per connection and builds all three
  // vec0 tables.
  it('ensureVecTables creates the three vec tables', () => {
    const cap = ensureVecTables(db);
    expect(cap.ok).toBe(true);
    const names = (
      db.prepare('SELECT name FROM sqlite_master').all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain('entity_vecs');
    expect(names).toContain('symbol_vecs');
    expect(names).toContain('doc_vecs');
  });

  // (c) KNN round-trip: insert a fake 384d vector, meta-map it, KNN it back.
  // Identical vector → L2 distance 0 → cosine ≈ 1.0.
  it('vecSearch KNN round-trips an inserted vector with cosine ≈ 1.0', () => {
    queryVec = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 0.1);
    const info = db
      .prepare('INSERT INTO entity_vecs(embedding) VALUES (?)')
      .run(Buffer.from(new Float32Array(queryVec).buffer));
    vecRowid = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO embeddings_meta (kind, doc_id, vec_rowid, hash, model, dim, source_path, embedded_at)
       VALUES ('entity', 'e1', ?, 'hash-e1', 'fake', 384, NULL, ?)`
    ).run(vecRowid, Date.now());

    const hits = vecSearch(db, 'entity_vecs', queryVec, 5);
    expect(hits.length).toBe(1);
    expect(hits[0].rowid).toBe(vecRowid);
    expect(hits[0].distance).toBe(0);
    expect(hits[0].cosine).toBeCloseTo(1.0, 5);
  });

  it('deleteVecRow removes a row (re-embed path)', () => {
    db.prepare('INSERT INTO entity_vecs(embedding) VALUES (?)').run(
      Buffer.from(new Float32Array(384).fill(0.5).buffer)
    );
    const rid = Number(
      db.prepare('SELECT rowid FROM entity_vecs ORDER BY rowid DESC LIMIT 1').get() as { rowid: number }
        .rowid
    );
    deleteVecRow(db, 'entity_vecs', rid);
    const gone = db.prepare('SELECT COUNT(*) c FROM entity_vecs WHERE rowid = ?').get(rid) as {
      c: number;
    };
    expect(gone.c).toBe(0);
  });

  // (d) RSK-6 pin / SRSR-04 phase-8 form: each vec table has its OWN rowid
  // sequence, so the SAME numeric rowid can exist in two tables — lookups
  // through embeddings_meta MUST filter (kind, vec_rowid).
  it('(kind, vec_rowid) filter disambiguates rowid collisions across vec tables', () => {
    const v = new Float32Array(384).fill(0.25);
    db.prepare('INSERT INTO entity_vecs(embedding) VALUES (?)').run(Buffer.from(v.buffer));
    const eRowid = Number(
      (db.prepare('SELECT rowid FROM entity_vecs ORDER BY rowid DESC LIMIT 1').get() as { rowid: number }).rowid
    );
    // Each vec table has its OWN rowid sequence — pad symbol_vecs with dummies
    // so its next real insert lands on the SAME rowid (a genuine collision).
    while (Number(
      (db.prepare('SELECT COALESCE(MAX(rowid), 0) m FROM symbol_vecs').get() as { m: number }).m
    ) < eRowid) {
      db.prepare('INSERT INTO symbol_vecs(embedding) VALUES (?)').run(Buffer.from(v.buffer));
    }
    const sRowid = Number(
      (db.prepare('SELECT rowid FROM symbol_vecs ORDER BY rowid DESC LIMIT 1').get() as { rowid: number }).rowid
    );
    expect(sRowid).toBe(eRowid);

    db.prepare(
      `INSERT INTO embeddings_meta (kind, doc_id, vec_rowid, hash, model, dim, source_path, embedded_at)
       VALUES ('entity', 'e2', ?, 'h-e2', 'fake', 384, 'src/a.ts', ?)`
    ).run(eRowid, Date.now());
    db.prepare(
      `INSERT INTO embeddings_meta (kind, doc_id, vec_rowid, hash, model, dim, source_path, embedded_at)
       VALUES ('symbol', 's2', ?, 'h-s2', 'fake', 384, 'src/b.ts', ?)`
    ).run(sRowid, Date.now());

    const entityDoc = db
      .prepare(`SELECT doc_id FROM embeddings_meta WHERE kind = 'entity' AND vec_rowid = ?`)
      .get(eRowid) as { doc_id: string };
    const symbolDoc = db
      .prepare(`SELECT doc_id FROM embeddings_meta WHERE kind = 'symbol' AND vec_rowid = ?`)
      .get(sRowid) as { doc_id: string };
    expect(entityDoc.doc_id).toBe('e2');
    expect(symbolDoc.doc_id).toBe('s2');
  });

  // (e) Extension loads per connection — a readonly serve-copy connection can
  // run ensureVecTables + KNN (RESEARCH §1.1).
  it('ensureVecTables works on a readonly connection', () => {
    const ro = new Database(dbPath, { readonly: true });
    try {
      const cap = ensureVecTables(ro);
      expect(cap.ok).toBe(true);
      const hits = vecSearch(ro, 'entity_vecs', queryVec, 1);
      expect(hits.length).toBe(1);
      expect(hits[0].rowid).toBe(vecRowid);
    } finally {
      ro.close();
    }
  });

  // (f) F-3 seam: a nonexistent loadable path forces the failure branch
  // without monkey-patching — degrades to ok:false, never throws.
  it('bogus loadable path returns ok:false with an error string', () => {
    const cap = ensureVecTables(db, join(tmpdir(), 'no-such-vec-ext'));
    expect(cap.ok).toBe(false);
    expect(typeof cap.error).toBe('string');
    expect(cap.error).toContain('ensureVecTables');
  });
});

describe('embedder contract', () => {
  it('SemanticUnavailableError is prefixed and carries the install hint', () => {
    const err = new SemanticUnavailableError('dependency not installed');
    expect(err.message.startsWith('embedder:')).toBe(true);
    expect(err.message).toContain('@huggingface/transformers');
  });

  it('MODEL_CONFIGS: both models are 384d, minilm default name', () => {
    expect(MODEL_CONFIGS.minilm.dim).toBe(384);
    expect(MODEL_CONFIGS.bge.dim).toBe(384);
    expect(MODEL_CONFIGS.minilm.name).toBe('Xenova/all-MiniLM-L6-v2');
    expect(MODEL_CONFIGS.bge.name).toBe('Xenova/bge-small-en-v1.5');
  });
});