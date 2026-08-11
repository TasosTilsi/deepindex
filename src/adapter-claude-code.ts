// Phase 3: Pure-function adapter. Returns the same JSON shape as the
// `serve` endpoint. No HTTP transport — the adapter is a library import
// (D-10). Reuses phase 2 retrieve + getHealth + getDependents/getDependencies.

import { initDb } from './graph/db.js';
import { retrieve, DEFAULT_TOP_K } from './retrieve.js';
import { getHealth, loadConfig, DEFAULT_HEALTH_CONFIG } from './health.js';
import { getDependents, getDependencies } from './graph/symbol-graph.js';
import { resolve as pathResolve } from 'node:path';
import type {
  HealthConfig,
  HealthReport,
  RetrieveHit,
  RetrieveSymbol,
} from './types.js';

export interface AdapterSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface AdapterTopFile {
  path: string;
  score: number;
  symbols: AdapterSymbol[];
  summary: string;
}

export interface AdapterNeighborhood {
  symbol: string;
  file: string;
  depth: number;
}

export interface AdapterResult {
  task: string;
  topFiles: AdapterTopFile[];
  neighborhood: AdapterNeighborhood[];
  health: HealthReport;
}

export interface AdaptOptions {
  topK?: number;
  dbPath?: string;
}

const NEIGHBORHOOD_CAP = 50;

export async function adaptClaudeCode(
  task: string,
  repoPath: string,
  opts: AdaptOptions = {}
): Promise<AdapterResult> {
  const dbPath = opts.dbPath ?? '.ctx.db';
  const topK = opts.topK ?? DEFAULT_TOP_K;
  const absRepo = pathResolve(repoPath);

  const db = initDb(dbPath);
  try {
    const hits: RetrieveHit[] = retrieve(db, task, { topK, repoPath: absRepo });
    const topFiles: AdapterTopFile[] = hits.map((h) => ({
      path: h.path,
      score: h.score,
      symbols: h.symbols.map(toAdapterSymbol),
      summary: h.summary,
    }));

    const config: HealthConfig = loadConfig(absRepo) ?? DEFAULT_HEALTH_CONFIG;
    const health: HealthReport = getHealth(db, { config });

    const neighborhood = buildNeighborhood(db, topFiles);

    return { task, topFiles, neighborhood, health };
  } finally {
    db.close();
  }
}

function toAdapterSymbol(s: RetrieveSymbol): AdapterSymbol {
  return {
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
    exported: s.exported,
  };
}

function buildNeighborhood(
  db: ReturnType<typeof initDb>,
  topFiles: AdapterTopFile[]
): AdapterNeighborhood[] {
  const seen = new Set<string>();
  const out: AdapterNeighborhood[] = [];

  const symById = db.prepare('SELECT id, name, file_id FROM symbols WHERE id = ?');
  const fileById = db.prepare('SELECT id, path FROM files WHERE id = ?');

  for (const tf of topFiles) {
    // Find the file's exported symbols by name to get IDs (the topFiles only
    // carry names+lines, not DB ids). To keep it simple, look up the FIRST
    // symbol row whose name matches each symbol in this file.
    for (const sym of tf.symbols) {
      const row = symById.all(sym.name) as { id: number; name: string; file_id: number }[];
      // Filter to those in this file (by path) — we'd need fileId from
      // fileById first. Quick approach: find by name and file path join.
      const fileRow = db
        .prepare('SELECT id FROM files WHERE path = ?')
        .get(tf.path) as { id: number } | undefined;
      if (!fileRow) continue;
      const myId = row.find((r) => r.file_id === fileRow.id)?.id;
      if (myId == null) continue;

      const related: number[] = [
        ...getDependents(db, myId, 1),
        ...getDependencies(db, myId, 1),
      ];
      for (const id of related) {
        const s = symById.get(id) as { id: number; name: string; file_id: number } | undefined;
        if (!s) continue;
        const f = fileById.get(s.file_id) as { id: number; path: string } | undefined;
        if (!f) continue;
        const key = `${s.name}|${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ symbol: s.name, file: f.path, depth: 1 });
        if (out.length >= NEIGHBORHOOD_CAP) return out;
      }
    }
  }
  return out;
}
