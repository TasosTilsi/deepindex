import type Database from 'better-sqlite3';

export interface ProjectedGraph {
  tables: Map<string, Set<number>>; // table -> queryIds
  queries: Map<number, string>;      // queryId -> filePath
  files: Map<string, string>;        // filePath -> serviceName
}

const SERVICE_RE = /(Service|Controller|Repository)[^/]*\.[^/]*$/i;

/** Derive a service name from a file path by taking the basename without
 *  extension, when the path looks like a service/controller/repository file. */
export function detectServiceName(path: string): string | null {
  const p = path.replace(/\\/g, '/');
  if (!SERVICE_RE.test(p)) return null;
  return p.split('/').pop()?.split('.')[0] ?? null;
}

export function projectFullGraph(db: Database.Database): ProjectedGraph {
  const graph: ProjectedGraph = {
    tables: new Map(),
    queries: new Map(),
    files: new Map(),
  };

  // 1. Table -> Query
  const tableRows = db
    .prepare('SELECT table_name, query_id FROM query_tables')
    .all() as { table_name: string; query_id: number }[];
  for (const { table_name, query_id } of tableRows) {
    let set = graph.tables.get(table_name);
    if (!set) {
      set = new Set();
      graph.tables.set(table_name, set);
    }
    set.add(query_id);
  }

  // 2. Query -> File
  const queryRows = db
    .prepare(
      `SELECT sq.id, f.path FROM sql_queries sq
       JOIN files f ON sq.file_id = f.id`
    )
    .all() as { id: number; path: string }[];
  for (const { id, path } of queryRows) {
    graph.queries.set(id, path);
  }

  // 3. File -> Service (path-based detection)
  const fileRows = db.prepare('SELECT path FROM files').all() as { path: string }[];
  for (const { path } of fileRows) {
    const service = detectServiceName(path);
    if (service) graph.files.set(path, service);
  }

  return graph;
}