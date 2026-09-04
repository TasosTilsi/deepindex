// Phase 7: Read-only dashboard API endpoints. Consumed by the React dashboard.
// All handlers are pure functions of db — no LLM, no mutation.

import type Database from 'better-sqlite3';
import { searchEntities, getRelatedRecursive } from '../git/search.js';
import { projectFullGraph } from '../graph/projection.js';
import { listProjects, type ProjectEntry } from '../registry.js';

/** List all registered projects (for the multi-project dashboard). */
export function apiProjects(registryPath?: string): { projects: ProjectEntry[] } {
  return { projects: listProjects(registryPath) };
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
    tables: count('query_tables'),
    commits: count('commits'),
    entityTypes,
  };
}

/** Entities + backlinks for the knowledge graph. */
export function apiEntities(db: Database.Database, limit = 200) {
  const entities = db
    .prepare('SELECT id, type, name, content FROM entities ORDER BY created_at DESC LIMIT ?')
    .all(limit) as { id: string; type: string; name: string; content: string }[];
  const backlinks = db
    .prepare('SELECT from_id, to_id, relationship FROM backlinks')
    .all() as { from_id: string; to_id: string; relationship: string }[];
  return { entities, backlinks };
}

/** Data-flow graph (Table↔Query↔Service). */
export function apiDataflow(db: Database.Database) {
  const g = projectFullGraph(db);
  const tables = [...g.tables.keys()].map((name) => ({ name, queryIds: [...(g.tables.get(name) ?? [])] }));
  const queries = [...g.queries.entries()].map(([id, file]) => ({ id, file }));
  const services = [...g.files.entries()].map(([file, service]) => ({ file, service }));
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

/** Route a GET /api/* path to its handler. Returns {status, body}. */
export function handleApi(db: Database.Database, url: string, registryPath?: string): { status: number; body: unknown } {
  const u = new URL(url, 'http://localhost');
  const path = u.pathname;
  const q = u.searchParams;

  if (path === '/api/projects') return { status: 200, body: apiProjects(registryPath) };
  if (path === '/api/overview') return { status: 200, body: apiOverview(db) };
  if (path === '/api/entities') {
    const limit = Number(q.get('limit') ?? 200);
    return { status: 200, body: apiEntities(db, limit) };
  }
  if (path === '/api/dataflow') return { status: 200, body: apiDataflow(db) };
  if (path === '/api/search') {
    const query = q.get('q') ?? '';
    const limit = Number(q.get('limit') ?? 20);
    return { status: 200, body: apiSearch(db, query, limit) };
  }
  if (path === '/api/symbols') {
    const limit = Number(q.get('limit') ?? 500);
    return { status: 200, body: apiSymbols(db, limit) };
  }
  return { status: 404, body: { error: 'not found' } };
}
