// Phase 2: Retrieval — tokenize, tfidf, retrieve. Hybrid ranking = 0.6*tfidf + 0.4*graphProximity.

import type Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';
import { getSymbolByName, getDependents } from './graph/query.js';
import type { RetrieveHit, RetrieveSymbol } from './types.js';

export const DEFAULT_TOP_K = 10;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const parts = lower.split(/[^a-z0-9_]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= 1) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export function tfidf(query: string[], docs: string[][]): number[] {
  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) {
    const uniq = new Set(d);
    for (const t of uniq) {
      if (query.includes(t)) {
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const scores: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    const d = docs[i];
    if (!d) continue;
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of query) {
      const f = tf.get(t) ?? 0;
      if (f === 0) continue;
      const dfreq = df.get(t) ?? 0;
      // Smoothed IDF: log(1 + N / (1 + df)) — never NaN.
      const idf = Math.log(1 + N / (1 + dfreq));
      s += (1 + Math.log(f)) * idf;
    }
    scores[i] = s;
  }
  return scores;
}

interface SymbolLite {
  id: number;
  fileId: number;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export function retrieve(
  db: Database.Database,
  query: string,
  opts: { topK?: number; repoPath?: string } = {}
): RetrieveHit[] {
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  // 1) Find seed symbols. Combine exact-match (case-insensitive) with LIKE substring match.
  const seedSymbolIds = new Set<number>();
  const allSeedRows: SymbolLite[] = [];
  for (const t of tokens) {
    const exact = getSymbolByName(db, t);
    for (const r of exact) {
      if (seedSymbolIds.has(r.id)) continue;
      seedSymbolIds.add(r.id);
      allSeedRows.push({
        id: r.id,
        fileId: r.file_id,
        name: r.name,
        kind: r.kind,
        startLine: r.start_line,
        endLine: r.end_line,
        exported: r.exported === 1,
      });
    }
    const like = db
      .prepare(
        `SELECT id, file_id, name, kind, start_line, end_line, exported
         FROM symbols WHERE LOWER(name) LIKE ?`
      )
      .all(`%${t}%`) as {
        id: number;
        file_id: number;
        name: string;
        kind: string;
        start_line: number;
        end_line: number;
        exported: number;
      }[];
    for (const r of like) {
      if (seedSymbolIds.has(r.id)) continue;
      seedSymbolIds.add(r.id);
      allSeedRows.push({
        id: r.id,
        fileId: r.file_id,
        name: r.name,
        kind: r.kind,
        startLine: r.start_line,
        endLine: r.end_line,
        exported: r.exported === 1,
      });
    }
  }
  if (seedSymbolIds.size === 0) return [];

  // 2) Graph BFS: depth 1 + depth 2 dependents. Bucket by depth.
  const fileDepth = new Map<number, number>();
  for (const s of allSeedRows) fileDepth.set(s.fileId, 0);
  for (const s of allSeedRows) {
    const d1 = getDependents(db, s.id, 1);
    for (const id of d1) {
      const row = db
        .prepare('SELECT file_id FROM symbols WHERE id = ?')
        .get(id) as { file_id: number } | undefined;
      if (row && !fileDepth.has(row.file_id)) fileDepth.set(row.file_id, 1);
    }
    const d2 = getDependents(db, s.id, 2);
    for (const id of d2) {
      const row = db
        .prepare('SELECT file_id FROM symbols WHERE id = ?')
        .get(id) as { file_id: number } | undefined;
      if (row && !fileDepth.has(row.file_id)) fileDepth.set(row.file_id, 2);
    }
  }
  const fileIds = [...fileDepth.keys()];

  // 3) Build docs for tfidf: file path tokens + exported symbol name tokens.
  const fileRows = db
    .prepare(
      `SELECT id, path FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`
    )
    .all(...fileIds) as { id: number; path: string }[];
  const filePathById = new Map<number, string>(fileRows.map((f) => [f.id, f.path]));

  const symbolRows = db
    .prepare(
      `SELECT file_id, name, kind, start_line, end_line, exported
       FROM symbols WHERE file_id IN (${fileIds.map(() => '?').join(',')})`
    )
    .all(...fileIds) as {
      file_id: number;
      name: string;
      kind: string;
      start_line: number;
      end_line: number;
      exported: number;
    }[];
  const symbolsByFile = new Map<number, RetrieveSymbol[]>();
  for (const s of symbolRows) {
    const arr = symbolsByFile.get(s.file_id) ?? [];
    arr.push({
      name: s.name,
      kind: s.kind,
      startLine: s.start_line,
      endLine: s.end_line,
      exported: s.exported === 1,
    });
    symbolsByFile.set(s.file_id, arr);
  }

  const docs: string[][] = fileIds.map((fid) => {
    const path = filePathById.get(fid) ?? '';
    const pathTokens = tokenize(path);
    const symTokens = (symbolsByFile.get(fid) ?? []).flatMap((s) => tokenize(s.name));
    return [...pathTokens, ...symTokens];
  });

  // 4) Compute scores.
  const tf = tfidf(tokens, docs);
  const ranked: { fileId: number; score: number; symbols: RetrieveSymbol[] }[] =
    fileIds.map((fid, i) => {
      const depth = fileDepth.get(fid) ?? 3;
      const proximity = 1 / (1 + depth);
      const score = 0.6 * (tf[i] ?? 0) + 0.4 * proximity;
      return {
        fileId: fid,
        score,
        symbols: symbolsByFile.get(fid) ?? [],
      };
    });
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked.slice(0, topK);

  return top.map((r) => {
    const path = filePathById.get(r.fileId) ?? '';
    const summary = buildSummary(opts.repoPath, path, r.symbols);
    return {
      path,
      score: r.score,
      symbols: r.symbols,
      summary,
    };
  });
}

function buildSummary(
  repoPath: string | undefined,
  relPath: string,
  symbols: RetrieveSymbol[]
): string {
  if (!repoPath || !relPath) return '';
  const absPath = `${repoPath.replace(/\/+$/, '')}/${relPath}`;
  if (!existsSync(absPath)) return '';
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
  const lines = text.split('\n');
  const excerpts: string[] = [];
  for (const s of symbols) {
    if (s.startLine < 1 || s.endLine < s.startLine) {
      excerpts.push(s.name);
      continue;
    }
    const start = s.startLine - 1;
    const end = Math.min(s.endLine, lines.length);
    const slice = lines.slice(start, end);
    const found = slice.find(
      (l) => /^\s*([^/\s#*].*)$/.test(l) && !/^\s*(\/\/|\/\*|\*|#)/.test(l)
    );
    excerpts.push(found ? found.trim() : s.name);
  }
  let summary = excerpts.join(' | ');
  if (summary.length > 200) summary = summary.slice(0, 197) + '...';
  return summary;
}
