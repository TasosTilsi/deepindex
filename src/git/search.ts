// Phase 5: FTS5 search over entities + backlink traversal (FTS-01/FTS-02).

import type Database from 'better-sqlite3';

export interface SearchHit {
  id: string;
  type: string;
  name: string;
  content: string;
  commitSha: string | null;
  rank: number;
  related: RelatedEntity[];
}

export interface RelatedEntity {
  id: string;
  type: string;
  name: string;
  relationship: string;
  context: string;
}

/** Build a safe FTS5 MATCH query from free text. FTS5 treats `-`, `:`, `"`,
 *  `*`, `^`, `(`, `)` etc. specially (e.g. `with-comments` → column `with`,
 *  value `comments`). Wrap each whitespace-separated term in double quotes so
 *  user queries never break the MATCH syntax. */
export function ftsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** FTS5 search over entities, ranked by bm25. */
export function searchEntities(db: Database.Database, query: string, limit = 10): SearchHit[] {
  if (!query.trim()) return [];
  const match = ftsQuery(query);
  const rows = db
    .prepare(
      `SELECT e.id, e.type, e.name, e.content, e.commit_sha, bm25(entities_fts) AS rank
       FROM entities_fts
       JOIN entities e ON e.rowid = entities_fts.rowid
       WHERE entities_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(match, limit) as Array<{
    id: string;
    type: string;
    name: string;
    content: string;
    commit_sha: string | null;
    rank: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    content: r.content,
    commitSha: r.commit_sha,
    rank: r.rank,
    related: getRelated(db, r.id),
  }));
}

/** 1-hop backlink traversal with relationship label + context (BKLN-02). */
export function getRelated(db: Database.Database, entityId: string): RelatedEntity[] {
  const rows = db
    .prepare(
      `SELECT b.to_id AS id, e.type, e.name, b.relationship, b.context
       FROM backlinks b
       JOIN entities e ON e.id = b.to_id
       WHERE b.from_id = ?`
    )
    .all(entityId) as Array<{
    id: string;
    type: string;
    name: string;
    relationship: string;
    context: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    relationship: r.relationship,
    context: r.context,
  }));
}

/** Multi-hop traversal with cycle guard (port of Recall's get_backlinks_recursive). */
export function getRelatedRecursive(
  db: Database.Database,
  entityId: string,
  depth = 2
): RelatedEntity[] {
  const seen = new Set<string>([entityId]);
  let frontier = [entityId];
  const result: RelatedEntity[] = [];
  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break;
    const placeholders = frontier.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT b.to_id AS id, e.type, e.name, b.relationship, b.context
         FROM backlinks b JOIN entities e ON e.id = b.to_id
         WHERE b.from_id IN (${placeholders})`
      )
      .all(...frontier) as Array<{
      id: string;
      type: string;
      name: string;
      relationship: string;
      context: string;
    }>;
    const next: string[] = [];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        result.push(r);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return result;
}
