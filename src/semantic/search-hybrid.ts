import type Database from 'better-sqlite3';
import { searchEntities, type SearchHit } from '../git/search.js';
import { retrieve } from '../retrieve.js';
import { ensureVecTables, vecSearch, type VecTable } from './vec.js';
import { firstLine } from './knowledge.js';
import { getEmbedder, resolveModelName, type Embedder } from './embedder.js';
import { loadSemanticConfig } from './config.js';

// Hybrid search core (D-28/D-28b): fuse three ranked sources — FTS5 entities
// (searchEntities), vec KNN over the lazy vec0 tables, and retrieve() file
// hits (retrieve() itself untouched, D-28) — into typed hits ranked by RRF
// (k=60, Cormack/Clarke/Buettcher SIGIR 2009; POC search.mjs pattern).
//
// ASYNC BY CONTRACT (F-1): the embedder interface is async (ONNX inference),
// so semantic/hybrid modes await the query embedding. Call sites: CLI search
// verb, MCP semantic_search handler, /api/search?mode= branch.
//
// Degradation (SRSR-03): lexical mode returns searchEntities output VERBATIM
// (byte-identical pin); semantic mode falls back to lexically-wrapped entity
// hits when semantic is disabled, the extension is unavailable, vec tables
// are empty, or the embedder cannot load (RSK-4 — never throws past here).

export type HitKind = 'entity' | 'symbol' | 'module' | 'doc' | 'file';

/** UI-SPEC R-B2 (binding): provenance discriminator. vec-derived → 'vec',
 *  FTS5 → 'lexical', retrieve()-file → 'graph'. Badge rendering keys on
 *  source, not mode. */
export type HitSource = 'vec' | 'lexical' | 'graph';

export interface HybridHit {
  kind: HitKind;
  id: string;
  label: string;
  path?: string;
  score: number;
  snippet?: string;
  source: HitSource;
}

export interface HybridSearchOptions {
  mode?: 'lexical' | 'semantic' | 'hybrid';
  limit?: number;
  /** Repo root for [semantic] config resolution + md-chunk re-reads. */
  repoPath?: string;
  /** Fake/injected embedder — wins over every resolution path (D-24b). */
  embedder?: Embedder;
  /** Loader-spy injection — called with the resolved model name. */
  loader?: (m: string) => Promise<Embedder>;
}

/** Deterministic kind tie-break order (OQ-11): identical fused scores render
 *  in a stable order so `${kind}:${id}` keys stay stable across surfaces. */
const KIND_RANK: Record<HitKind, number> = {
  entity: 0,
  symbol: 1,
  module: 2,
  doc: 3,
  file: 4,
};

const META_TABLE_KINDS: Record<VecTable, string[]> = {
  entity_vecs: ['entity'],
  symbol_vecs: ['symbol'],
  // Module cards and markdown docs share doc_vecs; (kind, vec_rowid)
  // disambiguates (POC search.mjs pattern, RSK-6).
  doc_vecs: ['module', 'doc'],
};

function compareHits(a: HybridHit, b: HybridHit): number {
  return (
    b.score - a.score ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function metaRowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) c FROM embeddings_meta').get() as { c: number }).c;
}

/** E-01/E-17 fallback contract: searchEntities hits wrapped as entity-kind
 *  HybridHits with source 'lexical' (UI renders `rank`, unaccented). */
function lexicalFallback(
  db: Database.Database,
  query: string,
  limit: number
): HybridHit[] {
  return searchEntities(db, query, limit).map((h) => ({
    kind: 'entity' as const,
    id: h.id,
    label: h.name,
    score: h.rank,
    snippet: firstLine(h.content),
    source: 'lexical' as const,
  }));
}

/** Vec-only hits for one query vector: KNN per vec table, each rowid mapped
 *  through embeddings_meta filtered by (kind, vec_rowid) — a rowid value
 *  present in two vec tables never cross-maps (SRSR-04 phase-8 form, RSK-6).
 *  REVIEW-FIX W3: label/snippet/source_path come from embeddings_meta
 *  (persisted at embed time) — NO corpus rebuild on the request path. A meta
 *  row without label (pre-extras DB embedded before the migration) degrades
 *  to an empty label rather than a full corpus read. */
function vecHits(
  db: Database.Database,
  queryVec: number[],
  limit: number
): HybridHit[] {
  const resolveExact = db.prepare(
    `SELECT kind, doc_id, label, snippet, source_path FROM embeddings_meta WHERE (kind, vec_rowid) = (?, ?)`
  );
  const resolveShared = db.prepare(
    `SELECT kind, doc_id, label, snippet, source_path FROM embeddings_meta WHERE vec_rowid = ? AND kind IN ('module','doc')`
  );
  const out: HybridHit[] = [];
  for (const table of ['entity_vecs', 'symbol_vecs', 'doc_vecs'] as const) {
    for (const v of vecSearch(db, table, queryVec, limit)) {
      let meta:
        | { kind: string; doc_id: string; label: string; snippet: string; source_path: string | null }
        | undefined;
      if (table === 'doc_vecs') {
        meta = resolveShared.get(v.rowid) as typeof meta;
      } else {
        const kind = table === 'entity_vecs' ? 'entity' : 'symbol';
        meta = resolveExact.get(kind, v.rowid) as typeof meta;
      }
      if (!meta) continue;
      const hit: HybridHit = {
        kind: meta.kind as HybridHit['kind'],
        id: meta.doc_id,
        label: meta.label || meta.doc_id,
        score: v.cosine,
        snippet: meta.snippet || undefined,
        source: 'vec',
      };
      if (meta.source_path) hit.path = meta.source_path;
      out.push(hit);
    }
  }
  return out.sort(compareHits).slice(0, limit);
}

/** RRF fusion (k=60): score = Σ 1/(k + rank) with rank starting at 1 (POC
 *  search.mjs:81-88). Lists merge by (kind, id) — a hit ranked first by both
 *  FTS5 and vec KNN legitimately scores 2/61. Ties break deterministically:
 *  fused score desc, then kind order (entity < symbol < module < doc < file),
 *  then id asc (OQ-11). k is NOT config-exposed (CONTEXT). */
export function rrfFuse(rankedList: { hit: HybridHit }[][], k = 60): HybridHit[] {
  const fused = new Map<string, HybridHit>();
  for (const list of rankedList) {
    for (const [i, entry] of list.entries()) {
      const contribution = 1 / (k + i + 1);
      const key = `${entry.hit.kind}:${entry.hit.id}`;
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(key, { ...entry.hit, score: contribution });
      }
    }
  }
  return [...fused.values()].sort(compareHits);
}

/** Hybrid search (D-28). mode 'lexical' → searchEntities VERBATIM
 *  (byte-identical pin, OQ-8/RSK-8); 'semantic' → vec-only cosine ranking;
 *  'hybrid' (default) → RRF over FTS5 + vec KNN + retrieve() file hits.
 *  CONFIG-AWARE MODEL SOURCE (D-24): the embedder model resolves from
 *  [semantic].model at repoPath — no surface threads a model, they pass
 *  repoPath only. */
export async function hybridSearch(
  db: Database.Database,
  query: string,
  opts: HybridSearchOptions = {}
): Promise<HybridHit[] | SearchHit[]> {
  const limit = opts.limit ?? 10;
  const repoPath = opts.repoPath ?? process.cwd();
  const mode = opts.mode ?? 'hybrid';

  if (mode === 'lexical') {
    // Byte-identical degradation pin: the SAME array searchEntities returns —
    // no remapping, no embedder/model resolution touched.
    return searchEntities(db, query, limit);
  }

  const cfg = loadSemanticConfig(repoPath);
  const model = resolveModelName(cfg);

  if (mode === 'semantic') {
    if (!cfg.enabled) {
      return lexicalFallback(db, query, limit);
    }
    const cap = ensureVecTables(db);
    if (!cap.ok) {
      console.warn(`hybridSearch: ${cap.error} — semantic mode degraded to lexical`);
      return lexicalFallback(db, query, limit);
    }
    if (metaRowCount(db) === 0) {
      console.warn('hybridSearch: no embedded docs — semantic mode degraded to lexical');
      return lexicalFallback(db, query, limit);
    }
    try {
      const embedder = await getEmbedder(model, {
        embedder: opts.embedder,
        loader: opts.loader,
      });
      const [queryVec] = await embedder.embed([query]);
      return vecHits(db, queryVec ?? [], limit);
    } catch (e) {
      console.warn(
        `hybridSearch: semantic layer unavailable (${
          e instanceof Error ? e.message : String(e)
        }) — degraded to lexical`
      );
      return lexicalFallback(db, query, limit);
    }
  }

  // mode 'hybrid': three ranked lists → rrfFuse. Vec list stays empty (and
  // the fusion degrades to FTS5 + file) whenever semantic is unavailable —
  // no meta rows, extension failure, or embedder failure (RSK-4).
  const lists: { hit: HybridHit }[][] = [
    searchEntities(db, query, limit).map((h) => ({
      hit: {
        kind: 'entity' as const,
        id: h.id,
        label: h.name,
        score: h.rank,
        snippet: firstLine(h.content),
        source: 'lexical' as const,
      },
    })),
  ];
  if (metaRowCount(db) > 0) {
    const cap = ensureVecTables(db);
    if (cap.ok) {
      try {
        const embedder = await getEmbedder(model, {
          embedder: opts.embedder,
          loader: opts.loader,
        });
        const [queryVec] = await embedder.embed([query]);
        lists.push(vecHits(db, queryVec ?? [], limit).map((hit) => ({ hit })));
      } catch (e) {
        console.warn(
          `hybridSearch: semantic layer unavailable (${
            e instanceof Error ? e.message : String(e)
          }) — hybrid degrades to FTS + file fusion`
        );
      }
    }
  }
  lists.push(
    retrieve(db, query, { topK: limit }).map((r) => ({
      hit: {
        kind: 'file' as const,
        id: r.path,
        label: r.path,
        path: r.path,
        score: r.score,
        source: 'graph' as const,
      },
    }))
  );
  return rrfFuse(lists);
}