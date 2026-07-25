import type Database from 'better-sqlite3';

export interface SymbolRow {
  id: number;
  file_id: number;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  exported: number;
}

export function getSymbolByName(
  db: Database.Database,
  name: string
): SymbolRow[] {
  return db
    .prepare('SELECT * FROM symbols WHERE name = ?')
    .all(name) as SymbolRow[];
}

export function getDependencies(
  db: Database.Database,
  symbolId: number,
  depth = 1
): number[] {
  if (depth < 0) return [];
  return runBfs(
    db,
    symbolId,
    'from_symbol_id',
    'to_symbol_id',
    depth
  );
}

export function getDependents(
  db: Database.Database,
  symbolId: number,
  depth = 1
): number[] {
  if (depth < 0) return [];
  return runBfs(
    db,
    symbolId,
    'to_symbol_id',
    'from_symbol_id',
    depth
  );
}

function runBfs(
  db: Database.Database,
  startId: number,
  fromCol: 'from_symbol_id' | 'to_symbol_id',
  toCol: 'from_symbol_id' | 'to_symbol_id',
  depth: number
): number[] {
  const seen = new Set<number>([startId]);
  let frontier = [startId];
  const result: number[] = [];
  for (let d = 0; d < depth; d++) {
    if (frontier.length === 0) break;
    const placeholders = frontier.map(() => '?').join(',');
    const sql = `SELECT DISTINCT ${toCol} AS id FROM edges WHERE ${fromCol} IN (${placeholders})`;
    const rows = db.prepare(sql).all(...frontier) as { id: number }[];
    const next: number[] = [];
    for (const r of rows) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        result.push(r.id);
        next.push(r.id);
      }
    }
    frontier = next;
  }
  return result;
}
