import type Database from 'better-sqlite3';

export interface TableProjection {
  [tableName: string]: Set<number>;
}

export function projectSqlImpact(db: Database.Database): TableProjection {
  const projection: TableProjection = {};

  const rows = db.prepare(
    `SELECT table_name, query_id FROM query_tables`
  ).all() as { table_name: string; query_id: number }[];

  for (const { table_name, query_id } of rows) {
    if (!projection[table_name]) {
      projection[table_name] = new Set();
    }
    projection[table_name].add(query_id);
  }

  return projection;
}

export function resolveQueryFile(db: Database.Database, queryId: number): string | null {
  const row = db.prepare(
    `SELECT f.path FROM sql_queries sq
     JOIN files f ON sq.file_id = f.id
     WHERE sq.id = ?`
  ).get(queryId) as { path: string } | undefined;

  return row?.path ?? null;
}
