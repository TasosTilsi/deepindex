import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { buildCorpus, firstLine, type SemanticDoc } from './knowledge.js';
import {
  ensureVecTables,
  deleteVecRow,
  EMBEDDING_DIM,
  type VecTable,
} from './vec.js';
import {
  type Embedder,
  getEmbedder,
  resolveModelName,
  hasCachedModel,
  FETCH_MODEL_COMMAND,
} from './embedder.js';
import {
  loadSemanticConfig,
  DEFAULT_SEMANTIC_CONFIG,
} from './config.js';

// Hash-guarded embedding lifecycle (D-25/D-26/D-21b). Doc texts are pure
// functions of db rows (+ one fs read per markdown file), so staleness is
// decidable with sha256 alone — the model is loaded lazily, only when stale
// docs actually need embedding (D-26c).

export interface EmbedResult {
  embedded: number;
  skipped: number;
  model: string;
  dim: number;
  corpusCounts: { entity: number; symbol: number; module: number; doc: number };
}

export interface EmbedOptions {
  rootDir: string;
  /** Fake/injected embedder — wins over every resolution path (D-24b: unit
   *  tests never touch native code). */
  embedder?: Embedder;
  /** Loader-spy injection (HOOK-04): called with the resolved model name. */
  loader?: (model: string) => Promise<Embedder>;
  /** Explicit model override; default is config-derived (rewired in Task 2
   *  to resolveModelName(loadSemanticConfig(rootDir)), D-24). */
  model?: string;
  /** Force re-embedding of every doc regardless of hash. */
  full?: boolean;
  /** TEST SEAM (plan 01 F-3): forwarded to ensureVecTables so tests can force
   *  the extension-unavailable degradation without monkey-patching. */
  vecLoadablePath?: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const KIND_TO_TABLE: Record<SemanticDoc['kind'], VecTable> = {
  entity: 'entity_vecs',
  symbol: 'symbol_vecs',
  module: 'doc_vecs',
  doc: 'doc_vecs',
};

function corpusCounts(corpus: SemanticDoc[]): EmbedResult['corpusCounts'] {
  const counts = { entity: 0, symbol: 0, module: 0, doc: 0 };
  for (const d of corpus) counts[d.kind]++;
  return counts;
}

interface MetaRow {
  kind: string;
  doc_id: string;
  vec_rowid: number;
  hash: string;
  model: string;
  dim: number;
}

/** Pure staleness check — NEVER loads the model (D-26c). Recomputes doc texts
 *  (db-only for entity/symbol/module; one fs read per markdown file) and
 *  compares sha256 against embeddings_meta.hash. Entity rows have sourcePath
 *  null → always hash-checked, cheap since their text comes from db. */
export function stalenessScan(
  db: Database.Database,
  rootDir: string
): {
  stale: Array<{ kind: string; docId: string; sourcePath: string | null }>;
  corpusCounts: EmbedResult['corpusCounts'];
} {
  const corpus = buildCorpus(db, rootDir);
  const meta = db
    .prepare('SELECT kind, doc_id, vec_rowid, hash, model, dim FROM embeddings_meta')
    .all() as MetaRow[];
  const byKey = new Map(meta.map((m) => [`${m.kind}:${m.doc_id}`, m]));
  const stale: Array<{ kind: string; docId: string; sourcePath: string | null }> = [];
  for (const doc of corpus) {
    const existing = byKey.get(`${doc.kind}:${doc.id}`);
    if (!existing || existing.hash !== sha256(doc.text)) {
      stale.push({ kind: doc.kind, docId: doc.id, sourcePath: doc.sourcePath });
    }
  }
  return { stale, corpusCounts: corpusCounts(corpus) };
}

/** Dashboard /api/embed-status payload (plan 03 consumes; UI-SPEC §1.2).
 *  Pure db + fs — NEVER loads the model (D-26c). */
export interface EmbedStatusPayload {
  available: boolean;
  hint?: string;
  model?: string;
  dim?: number;
  lastEmbedAt?: string;
  coverage?: number;
  staleCount?: number;
  corpusCounts: { entity: number; symbol: number; module: number; doc: number };
}

const VEC_TABLE_NAMES = ['entity_vecs', 'symbol_vecs', 'doc_vecs'] as const;

function countVecRows(db: Database.Database): number {
  const existing = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name)
  );
  let total = 0;
  for (const table of VEC_TABLE_NAMES) {
    if (!existing.has(table)) continue;
    const row = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    total += row.c;
  }
  return total;
}

/** Embedding status for the dashboard: coverage, staleness, model info.
 *  available = semantic.enabled AND model cached AND ≥1 embedded row. */
export function embedStatus(db: Database.Database, repoPath: string): EmbedStatusPayload {
  const cfg = loadSemanticConfig(repoPath) ?? DEFAULT_SEMANTIC_CONFIG;
  const model = resolveModelName(cfg);
  const scan = stalenessScan(db, repoPath);
  const corpusSize = scan.corpusCounts.entity + scan.corpusCounts.symbol +
    scan.corpusCounts.module + scan.corpusCounts.doc;
  const embeddedRows = (
    db.prepare('SELECT COUNT(*) c FROM embeddings_meta').get() as { c: number }
  ).c;
  const cached = hasCachedModel(model);
  const vecRows = countVecRows(db);
  const available = cfg.enabled && cached && vecRows > 0;
  const lastRow = db
    .prepare('SELECT MAX(embedded_at) m FROM embeddings_meta')
    .get() as { m: number | null };
  const payload: EmbedStatusPayload = {
    available,
    corpusCounts: scan.corpusCounts,
  };
  if (!available) {
    payload.hint = cfg.enabled
      ? `run ${FETCH_MODEL_COMMAND} to cache the model`
      : `run ${FETCH_MODEL_COMMAND}, then set [semantic] enabled = true in .deepindex.toml`;
  }
  payload.model = model;
  payload.dim = EMBEDDING_DIM;
  payload.coverage = corpusSize === 0 ? 0 : embeddedRows / corpusSize;
  payload.staleCount = scan.stale.length;
  if (lastRow.m !== null) payload.lastEmbedAt = new Date(lastRow.m).toISOString();
  return payload;
}

/** D-26b auto-embed gate, run after index and git-sync: embeds ONLY when
 *  semantic.enabled AND the model is already cached; otherwise prints a
 *  one-line hint (the `embed` verb remains the bootstrap). Never downloads —
 *  there is no network outside `--fetch-model` (D-23). The model loads
 *  lazily, only when stalenessScan finds changed docs (D-26c). `opts.loader`
 *  is a test pass-through to embed() so the gate is observable without a
 *  native model. */
export async function autoEmbedStep(
  db: Database.Database,
  repoPath: string,
  opts: { loader?: (m: string) => Promise<Embedder> } = {}
): Promise<void> {
  const cfg = loadSemanticConfig(repoPath) ?? DEFAULT_SEMANTIC_CONFIG;
  if (cfg.enabled && hasCachedModel(resolveModelName(cfg))) {
    const scan = stalenessScan(db, repoPath);
    if (scan.stale.length > 0) {
      await embed(db, { rootDir: repoPath, loader: opts.loader });
    }
    // stale.length === 0 → log nothing (D-26b).
  } else {
    console.log(
      `semantic embedding not enabled — run ${FETCH_MODEL_COMMAND} then set [semantic] enabled = true`
    );
  }
}

/** Hash-guarded incremental embedding (POC embed.mjs pattern, EMBD-01/05):
 *  embed every stale doc, skip the rest. Model/dim mismatch against
 *  embeddings_meta forces a full re-embed with a warning (D-21b) — never
 *  silent reuse. Returns early with vec tables untouched when the sqlite-vec
 *  extension is unavailable (SRSR-03 degradation). */
export async function embed(
  db: Database.Database,
  opts: EmbedOptions
): Promise<EmbedResult> {
  const corpus = buildCorpus(db, opts.rootDir);
  // CONFIG-AWARE model default (D-24): a `[semantic] model = bge` user gets
  // bge end-to-end without ANY call site threading model — the embed verb,
  // autoEmbedStep and the sessionStart chain all call embed() with no model
  // and inherit this resolution.
  const model = opts.model ?? resolveModelName(loadSemanticConfig(opts.rootDir));
  const counts = corpusCounts(corpus);

  // REVIEW-FIX W2: capability check moved BEFORE the empty-stale early return —
  // orphan purge below must run even when nothing is stale (deleted/renamed
  // docs otherwise orphan their meta+vec rows forever).
  const cap = ensureVecTables(db, opts.vecLoadablePath);
  if (!cap.ok) {
    console.warn(`embed: ${cap.error} — embedding disabled this run`);
    return {
      embedded: 0,
      skipped: corpus.length,
      model,
      dim: EMBEDDING_DIM,
      corpusCounts: counts,
    };
  }

  const metaRows = db
    .prepare('SELECT kind, doc_id, vec_rowid, hash, model, dim FROM embeddings_meta')
    .all() as MetaRow[];
  const byKey = new Map(metaRows.map((m) => [`${m.kind}:${m.doc_id}`, m]));
  const corpusKeys = new Set(corpus.map((d) => `${d.kind}:${d.id}`));

  // REVIEW-FIX W2: mismatch wipes ALL rows first — rows recorded under the old
  // model/dim are invalid even when their doc still exists, so a purge-by-
  // absence alone could never converge (mismatch would stay true forever).
  // The full re-embed below then repopulates from scratch and the hash guard
  // converges on the next run.
  if (metaRows.some((m) => m.model !== model || m.dim !== EMBEDDING_DIM)) {
    console.warn('embed: model/dim mismatch — re-embedding all docs');
    db.transaction(() => {
      for (const m of metaRows) deleteVecRow(db, KIND_TO_TABLE[m.kind as SemanticDoc['kind']], m.vec_rowid);
      db.prepare('DELETE FROM embeddings_meta').run();
    })();
  }

  // REVIEW-FIX W2: orphan purge — meta rows whose doc no longer exists in the
  // corpus (deleted/renamed source, dropped entity) are removed together with
  // their vec rows, so deleted docs stop consuming KNN k-slots and staleCount
  // /coverage converge. Runs on every embed, cheap (one indexed scan).
  db.transaction(() => {
    const del = db.prepare('DELETE FROM embeddings_meta WHERE kind = ? AND doc_id = ?');
    for (const m of metaRows) {
      if (corpusKeys.has(`${m.kind}:${m.doc_id}`)) continue;
      const table = KIND_TO_TABLE[m.kind as SemanticDoc['kind']];
      if (table) deleteVecRow(db, table, m.vec_rowid);
      del.run(m.kind, m.doc_id);
    }
  })();

  const staleDocs = opts.full
    ? corpus
    : corpus.filter((doc) => {
        const existing = byKey.get(`${doc.kind}:${doc.id}`);
        const nowMismatched =
          existing && (existing.model !== model || existing.dim !== EMBEDDING_DIM);
        return !existing || existing.hash !== sha256(doc.text) || nowMismatched;
      });

  const result: EmbedResult = {
    embedded: 0,
    skipped: corpus.length - staleDocs.length,
    model,
    dim: EMBEDDING_DIM,
    corpusCounts: counts,
  };
  if (staleDocs.length === 0) return result;

  // Lazy embedder resolution via the shared resolver (D-24b/D-26c): only
  // reached when stale docs exist and the vec layer is usable. opts.embedder
  // (fake injection) wins, then the loader-spy seam, then the cache gate —
  // an empty cache refuses with FETCH_MODEL_COMMAND (D-23).
  const embedder = await getEmbedder(model, {
    embedder: opts.embedder,
    loader: opts.loader,
  });

  const upsertMeta = db.prepare(
    `INSERT INTO embeddings_meta (kind, doc_id, vec_rowid, hash, model, dim, source_path, embedded_at, label, snippet)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, doc_id) DO UPDATE SET
       vec_rowid = excluded.vec_rowid,
       hash = excluded.hash,
       model = excluded.model,
       dim = excluded.dim,
       source_path = excluded.source_path,
       embedded_at = excluded.embedded_at,
       label = excluded.label,
       snippet = excluded.snippet`
  );
  const selectMeta = db.prepare(
    'SELECT vec_rowid FROM embeddings_meta WHERE kind = ? AND doc_id = ?'
  );

  // One embedder call + one transaction per kind batch.
  let embedded = 0;
  for (const kind of ['entity', 'symbol', 'module', 'doc'] as const) {
    const batch = staleDocs.filter((d) => d.kind === kind);
    if (batch.length === 0) continue;
    const table = KIND_TO_TABLE[kind];
    const vectors = await embedder.embed(batch.map((d) => d.text));
    const insertVec = db.prepare(`INSERT INTO ${table}(embedding) VALUES (?)`);
    db.transaction(() => {
      for (const [i, doc] of batch.entries()) {
        const existing = selectMeta.get(kind, doc.id) as
          | { vec_rowid: number }
          | undefined;
        if (existing) deleteVecRow(db, table, existing.vec_rowid);
        const buf = Buffer.from(new Float32Array(vectors[i]!).buffer);
        const info = insertVec.run(buf);
        const rowid = Number(info.lastInsertRowid);
        upsertMeta.run(
          kind,
          doc.id,
          rowid,
          sha256(doc.text),
          model,
          EMBEDDING_DIM,
          doc.sourcePath,
          Date.now(),
          doc.label,
          firstLine(doc.text)
        );
        embedded++;
      }
    })();
  }

  result.embedded = embedded;
  result.skipped = corpus.length - embedded;
  return result;
}