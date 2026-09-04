// Phase 6: MCP tools — 6 read-only tools over the merged store (D-07/D-11).
// All logging to stderr only (never stdout — corrupts MCP protocol).

import type Database from 'better-sqlite3';
import { z } from 'zod';
import { searchEntities, getRelatedRecursive } from '../git/search.js';
import { projectFullGraph } from '../graph/projection.js';

// --- Tool schemas (zod) ---

export const searchKnowledgeSchema = {
  query: z.string().describe('FTS5 search terms'),
  limit: z.number().int().min(1).max(100).default(20).optional(),
};

export const getEntitySchema = {
  entity_id: z.string().describe('Entity UUID or exact name'),
};

export const getBacklinksSchema = {
  entity_id: z.string().describe('Entity UUID or exact name'),
  hops: z.number().int().min(1).max(5).default(1).optional(),
};

export const typeListSchema = {
  limit: z.number().int().min(1).max(100).default(20).optional(),
};

// --- Tool implementations ---

/** search_knowledge — FTS5 search across entity name+content. */
export function searchKnowledge(db: Database.Database, args: { query: string; limit?: number }) {
  const hits = searchEntities(db, args.query, args.limit ?? 20);
  return {
    results: hits.map((h) => ({
      id: h.id,
      name: h.name,
      type: h.type,
      content: h.content,
      source_commit: h.commitSha,
      related: h.related.map((r) => ({ id: r.id, name: r.name, type: r.type, relationship: r.relationship })),
    })),
  };
}

/** get_entity — fetch by UUID first, fallback to exact name. Enriched with
 *  linked symbols + data-flow context (D-11, MCP-03). */
export function getEntity(db: Database.Database, args: { entity_id: string }) {
  const row = db
    .prepare('SELECT id, type, name, content, commit_sha, created_at, last_seen FROM entities WHERE id = ?')
    .get(args.entity_id) as EntityRow | undefined;
  const byName = row
    ? row
    : (db
        .prepare('SELECT id, type, name, content, commit_sha, created_at, last_seen FROM entities WHERE name = ?')
        .get(args.entity_id) as EntityRow | undefined);
  if (!byName) return { error: 'entity not found', id: args.entity_id };
  return { ...byName, ...mergedContext(db, byName.id) };
}

/** get_backlinks — multi-hop traversal with cycle guard. Enriched with
 *  linked symbols + data-flow (D-11). */
export function getBacklinks(db: Database.Database, args: { entity_id: string; hops?: number }) {
  const row = db.prepare('SELECT id FROM entities WHERE id = ? OR name = ?').get(args.entity_id, args.entity_id) as
    | { id: string }
    | undefined;
  if (!row) return { error: 'entity not found', id: args.entity_id };
  const related = getRelatedRecursive(db, row.id, args.hops ?? 1);
  return {
    entity_id: row.id,
    hops: args.hops ?? 1,
    related: related.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      relationship: r.relationship,
      context: r.context,
    })),
  };
}

/** Type-filtered entity lists. */
export function listByType(db: Database.Database, type: string, limit: number) {
  const rows = db
    .prepare('SELECT id, type, name, content, commit_sha FROM entities WHERE type = ? ORDER BY created_at DESC LIMIT ?')
    .all(type, limit) as EntityRow[];
  return { results: rows };
}

export function getDecisions(db: Database.Database, args: { limit?: number }) {
  return listByType(db, 'decision', args.limit ?? 20);
}
export function getBugs(db: Database.Database, args: { limit?: number }) {
  return listByType(db, 'bug_fix', args.limit ?? 20);
}
export function getPatterns(db: Database.Database, args: { limit?: number }) {
  return listByType(db, 'pattern', args.limit ?? 20);
}

// --- Helpers ---

interface EntityRow {
  id: string;
  type: string;
  name: string;
  content: string;
  commit_sha: string | null;
  created_at: string;
  last_seen: string;
}

/** Merged-store context: linked symbols (entity_symbols) + data-flow (D-11). */
function mergedContext(db: Database.Database, entityId: string) {
  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, f.path
       FROM entity_symbols es
       JOIN symbols s ON s.id = es.symbol_id
       JOIN files f ON f.id = s.file_id
       WHERE es.entity_id = ?`
    )
    .all(entityId) as { id: number; name: string; kind: string; path: string }[];
  let dataFlow: { tables: number; queries: number; services: number } | undefined;
  try {
    const g = projectFullGraph(db);
    dataFlow = { tables: g.tables.size, queries: g.queries.size, services: g.files.size };
  } catch {
    dataFlow = undefined;
  }
  return { symbols, dataFlow };
}
