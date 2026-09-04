// Phase 7: Read-only dashboard API endpoints. Consumed by the React dashboard.
// All handlers are pure functions of db — no LLM, no mutation.

import type Database from 'better-sqlite3';
import { searchEntities, getRelated } from '../git/search.js';
import { getHealth } from '../health.js';
import { projectFullGraph } from '../graph/projection.js';
import { listProjects, discoverProjects, type ProjectEntry } from '../registry.js';

/** List all projects: registered (home registry) + discovered (.deepindex.db
 *  files in the current dir tree). Dedup by path. */
export function apiProjects(registryPath?: string, rootDir?: string): { projects: ProjectEntry[] } {
  const byPath = new Map<string, ProjectEntry>();
  for (const p of listProjects(registryPath)) byPath.set(p.path, p);
  if (rootDir) {
    for (const p of discoverProjects(rootDir)) {
      if (!byPath.has(p.path)) byPath.set(p.path, p);
    }
  }
  return { projects: [...byPath.values()] };
}

/** Overview counts across the merged store. */
export function apiOverview(db: Database.Database) {
  const count = (table: string) => {
    const row = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
    return row.c;
  };
  const entityTypes = db
    .prepare('SELECT type, COUNT(*) c FROM entities GROUP BY type ORDER BY c DESC')
    .all() as { type: string; c: number }[];
  return {
    files: count('files'),
    symbols: count('symbols'),
    entities: count('entities'),
    backlinks: count('backlinks'),
    tables: count('query_tables'),
    commits: count('commits'),
    entityTypes,
  };
}

/** Entities + backlinks for the knowledge graph. Content is truncated to a
 *  snippet (the graph only shows it in tooltips) and backlinks are limited to
 *  edges between the returned entities — the client renders exactly these
 *  nodes, so an unbounded backlinks scan just bloats the payload with edges
 *  pointing at nodes that are never displayed. */
export function apiEntities(db: Database.Database, limit = 200) {
  const entities = db
    .prepare(
      `SELECT id, type, name, substr(content, 1, 160) AS content, created_at
       FROM entities ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as { id: string; type: string; name: string; content: string; created_at: string }[];
  if (entities.length === 0) return { entities, backlinks: [] };
  const ph = entities.map(() => '?').join(',');
  const backlinks = db
    .prepare(
      `SELECT from_id, to_id, relationship FROM backlinks
       WHERE from_id IN (${ph}) AND to_id IN (${ph})`
    )
    .all(...entities.map((e) => e.id), ...entities.map((e) => e.id)) as {
    from_id: string;
    to_id: string;
    relationship: string;
  }[];
  return { entities, backlinks };
}

/** Data-flow graph (Table↔Query↔Service). Capped so the payload and the
 *  vis-network render stay bounded on large repos. `limit` applies to each
 *  node category; table queryIds are filtered to the included queries so the
 *  client never receives edges to nodes it cannot draw. Service nodes cover
 *  both detected service files and every file that runs an included query —
 *  otherwise query→file edges would reference nodes the client can't draw. */
export function apiDataflow(db: Database.Database, limit = 200) {
  const g = projectFullGraph(db);
  const queries = [...g.queries.entries()].slice(0, limit).map(([id, file]) => ({ id, file }));
  const queryIds = new Set(queries.map((q) => q.id));
  const tables = [...g.tables.entries()]
    .slice(0, limit)
    .map(([name, ids]) => ({ name, queryIds: [...ids].filter((id) => queryIds.has(id)) }));
  const files = new Map(g.files);
  for (const q of queries) {
    if (!files.has(q.file)) files.set(q.file, '');
  }
  const services = [...files.entries()].slice(0, limit).map(([file, service]) => ({ file, service }));
  return { tables, queries, services };
}

/** Search across entities. */
export function apiSearch(db: Database.Database, query: string, limit = 20) {
  return searchEntities(db, query, limit);
}

/** Symbol/file browser. */
export function apiSymbols(db: Database.Database, limit = 500) {
  const files = db
    .prepare('SELECT id, path, language FROM files ORDER BY path LIMIT ?')
    .all(limit) as { id: number; path: string; language: string | null }[];
  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.file_id, f.path
       FROM symbols s JOIN files f ON f.id = s.file_id
       ORDER BY f.path, s.name LIMIT ?`
    )
    .all(limit) as { id: number; name: string; kind: string; file_id: number; path: string }[];
  return { files, symbols };
}

/** Health report (score 0-100, dimensions, issues) for the Index Health card. */
export function apiHealth(db: Database.Database) {
  return getHealth(db);
}

export interface CommitEntity {
  id: string;
  name: string;
  type: string;
}

export interface CommitEntry {
  sha: string;
  message: string;
  author: string;
  author_date: string;
  insertions: number;
  deletions: number;
  commit_type: string;
  entityCount: number;
  entities: CommitEntity[];
}

/** Commit timeline ("episodes") with per-commit extracted entities. */
export function apiCommits(db: Database.Database, limit = 50): { commits: CommitEntry[] } {
  const commits = db
    .prepare(
      `SELECT sha, message, author, author_date, insertions, deletions, commit_type
       FROM commits ORDER BY author_date DESC LIMIT ?`
    )
    .all(limit) as Array<Omit<CommitEntry, 'entityCount' | 'entities'>>;
  const ph = commits.length === 0 ? '' : `AND e.commit_sha IN (${commits.map(() => '?').join(',')})`;
  const ents = (
    db
      .prepare(
        `SELECT e.commit_sha, e.id, e.name, e.type FROM entities e
         WHERE e.commit_sha IS NOT NULL ${ph}`
      )
      .all(...commits.map((c) => c.sha)) as Array<{ commit_sha: string; id: string; name: string; type: string }>
  ).map((r) => ({
    commitSha: r.commit_sha,
    id: r.id,
    name: r.name,
    type: r.type,
  }));
  const byCommit = new Map<string, CommitEntity[]>();
  for (const e of ents) {
    const list = byCommit.get(e.commitSha) ?? [];
    list.push({ id: e.id, name: e.name, type: e.type });
    byCommit.set(e.commitSha, list);
  }
  return {
    commits: commits.map((c) => {
      const list = byCommit.get(c.sha) ?? [];
      return { ...c, entityCount: list.length, entities: list.slice(0, 8) };
    }),
  };
}

export interface ActivityWeek {
  week: string;
  entities: number;
  commits: number;
}

/** Weekly activity series (entities created + commits authored) for the
 *  velocity + growth charts, oldest first. */
export function apiActivity(db: Database.Database, weeks = 12): { activity: ActivityWeek[] } {
  const entityRows = db
    .prepare(
      `SELECT strftime('%Y-%W', created_at) AS week, COUNT(*) AS n
       FROM entities GROUP BY week ORDER BY week DESC LIMIT ?`
    )
    .all(weeks) as { week: string; n: number }[];
  const commitRows = db
    .prepare(
      `SELECT strftime('%Y-%W', author_date) AS week, COUNT(*) AS n
       FROM commits GROUP BY week ORDER BY week DESC LIMIT ?`
    )
    .all(weeks) as { week: string; n: number }[];
  const weeksMap = new Map<string, ActivityWeek>();
  for (const r of entityRows) weeksMap.set(r.week, { week: r.week, entities: r.n, commits: 0 });
  for (const r of commitRows) {
    const w = weeksMap.get(r.week);
    if (w) w.commits = r.n;
    else weeksMap.set(r.week, { week: r.week, entities: 0, commits: r.n });
  }
  const activity = [...weeksMap.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  return { activity };
}

export interface RelationEntry {
  from_id: string;
  to_id: string;
  relationship: string;
  context: string;
  from_name: string;
  from_type: string;
  to_name: string;
  to_type: string;
}

/** Backlinks ("relations") with both endpoints' names and types. */
export function apiRelations(db: Database.Database, limit = 100): RelationEntry[] {
  return db
    .prepare(
      `SELECT b.from_id, b.to_id, b.relationship, b.context,
              fe.name AS from_name, fe.type AS from_type,
              te.name AS to_name, te.type AS to_type
       FROM backlinks b
       JOIN entities fe ON fe.id = b.from_id
       JOIN entities te ON te.id = b.to_id
       ORDER BY b.from_id LIMIT ?`
    )
    .all(limit) as RelationEntry[];
}

/** Full entity detail for the graph node selection panel. Returns null when
 *  the id is unknown (caller maps that to a 404). */
export function apiEntity(
  db: Database.Database,
  id: string
): { entity: Record<string, unknown>; commit: Record<string, unknown> | null; related: unknown[] } | null {
  const entity = db
    .prepare(
      `SELECT id, type, name, content, tags, created_at, last_seen, commit_sha
       FROM entities WHERE id = ?`
    )
    .get(id) as
    | { id: string; type: string; name: string; content: string; tags: string; created_at: string; last_seen: string; commit_sha: string | null }
    | undefined;
  if (!entity) return null;
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(entity.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  const commit = entity.commit_sha
    ? (db
        .prepare('SELECT sha, message, author, author_date FROM commits WHERE sha = ?')
        .get(entity.commit_sha) as { sha: string; message: string; author: string; author_date: string } | undefined)
    : undefined;
  return {
    entity: { ...entity, tags },
    commit: commit ?? null,
    related: getRelated(db, id),
  };
}

/** Route a GET /api/* path to its handler. Returns {status, body}. */
export function handleApi(db: Database.Database, url: string, registryPath?: string, rootDir?: string): { status: number; body: unknown } {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;
  const q = u.searchParams;
  // Clamp query-supplied limits: NaN or negative values must not reach SQLite
  // (better-sqlite3 rejects NaN binds; LIMIT -1 means "no limit"). A missing
  // param must fall back to the default — Number(null) is 0, so guard it.
  const limitParam = (raw: string | null, dflt: number): number => {
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
  };

  if (path === '/api/projects') return { status: 200, body: apiProjects(registryPath, rootDir) };
  if (path === '/api/overview') return { status: 200, body: apiOverview(db) };
  if (path === '/api/health') return { status: 200, body: apiHealth(db) };
  if (path === '/api/entities') {
    const limit = limitParam(q.get('limit'), 200);
    return { status: 200, body: apiEntities(db, limit) };
  }
  if (path === '/api/dataflow') {
    const limit = limitParam(q.get('limit'), 200);
    return { status: 200, body: apiDataflow(db, limit) };
  }
  if (path === '/api/commits') {
    const limit = limitParam(q.get('limit'), 50);
    return { status: 200, body: apiCommits(db, limit) };
  }
  if (path === '/api/relations') {
    const limit = limitParam(q.get('limit'), 100);
    return { status: 200, body: apiRelations(db, limit) };
  }
  if (path === '/api/activity') {
    const limit = limitParam(q.get('weeks'), 12);
    return { status: 200, body: apiActivity(db, limit) };
  }
  if (path === '/api/entity') {
    const id = q.get('id') ?? '';
    const r = apiEntity(db, id);
    if (!r) return { status: 404, body: { error: 'entity not found' } };
    return { status: 200, body: r };
  }
  if (path === '/api/search') {
    const query = q.get('q') ?? '';
    const limit = limitParam(q.get('limit'), 20);
    return { status: 200, body: apiSearch(db, query, limit) };
  }
  if (path === '/api/symbols') {
    const limit = limitParam(q.get('limit'), 500);
    return { status: 200, body: apiSymbols(db, limit) };
  }
  return { status: 404, body: { error: 'not found' } };
}
