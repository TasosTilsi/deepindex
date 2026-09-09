import type Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';

// All sqlite-vec / vec0 knowledge lives in this module. The extension is
// loaded PER CONNECTION (sqlite-vec rule) and the vec0 tables are created
// lazily — initDb (schema v6) never touches any of this so readonly
// watcher/serve connections keep working without the extension (RSK-2).
//
// sqlite-vec 0.1.9 empirical facts (RESEARCH §1.1):
// - Declared-PK inserts are broken → auto-rowid tables only; embeddings_meta
//   maps doc → vec_rowid, and every lookup filters (kind, vec_rowid).
// - The cosine table option (distance-metric selector) is unsupported in
//   0.1.9 → L2 is the ranking metric; on unit (normalized) vectors L2 is
//   monotonic with cosine and cos = 1 − d²/2 converts for display.

/** Embedding dimension for both supported models (MiniLM and bge-small are
 *  both 384d — one vec dim serves both, D-21b). */
export const EMBEDDING_DIM = 384;

/** The three vec0 tables, created lazily per connection. Module cards and
 *  markdown docs share doc_vecs; discrimination is (kind, doc_id) in
 *  embeddings_meta. */
export const VEC_TABLES = ['entity_vecs', 'symbol_vecs', 'doc_vecs'] as const;

export type VecTable = (typeof VEC_TABLES)[number];

export interface VecCapability {
  ok: boolean;
  error?: string;
}

export interface VecSearchHit {
  rowid: number;
  distance: number;
  cosine: number;
}

function isVecTable(table: string): table is VecTable {
  return (VEC_TABLES as readonly string[]).includes(table);
}

/** On normalized vectors, L2 distance converts to cosine similarity:
 *  cos = 1 − d²/2 (verified numerically in RESEARCH §1.1). */
export function l2ToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

/** Load the sqlite-vec extension on this connection and create the three
 *  vec0 tables. `loadablePath` is the TEST SEAM: production callers omit it
 *  (defaults to the sqlite-vec-shipped path); tests pass a bogus path to
 *  force the failure branch without monkey-patching (F-3). Never throws past
 *  this function — load/creation failure degrades to { ok: false, error }
 *  (SRSR-03). */
export function ensureVecTables(
  db: Database.Database,
  loadablePath: string = getLoadablePath()
): VecCapability {
  try {
    db.loadExtension(loadablePath);
  } catch (e) {
    return {
      ok: false,
      error: `ensureVecTables: sqlite-vec extension failed to load (${loadablePath}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  try {
    for (const table of VEC_TABLES) {
      // Auto-rowid only: NO declared PK column (broken in 0.1.9) and NO
      // cosine table option (unsupported in 0.1.9 — L2 ranks, display
      // converts via l2ToCosine).
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${EMBEDDING_DIM}])`
      );
    }
  } catch (e) {
    return {
      ok: false,
      error: `ensureVecTables: vec0 table creation failed: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
  return { ok: true };
}

/** Bind a query vector the way vec0 KNN expects (little-endian f32 buffer). */
function toVecBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** KNN search over one vec0 table. Returns rowids with L2 distance and the
 *  cosine-similarity conversion for display. `table` is whitelisted — it is
 *  interpolated into SQL. */
export function vecSearch(
  db: Database.Database,
  table: VecTable,
  queryVec: number[],
  k = 10
): VecSearchHit[] {
  if (!isVecTable(table)) {
    throw new Error(`vecSearch: unknown vec table "${table}"`);
  }
  const stmt = db.prepare(
    `SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? AND k = ?`
  );
  const rows = stmt.all(toVecBuffer(queryVec), k) as {
    rowid: number;
    distance: number;
  }[];
  return rows.map((r) => ({
    rowid: r.rowid,
    distance: r.distance,
    cosine: l2ToCosine(r.distance),
  }));
}

/** Delete one vec row by rowid — the re-embed path (hash changed → delete
 *  stale row, insert fresh, upsert embeddings_meta). */
export function deleteVecRow(
  db: Database.Database,
  table: VecTable,
  rowid: number
): void {
  if (!isVecTable(table)) {
    throw new Error(`deleteVecRow: unknown vec table "${table}"`);
  }
  db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rowid);
}