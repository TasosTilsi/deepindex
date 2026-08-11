import type Database from 'better-sqlite3';

export interface CoverageReport {
  orphanRequirements: { id: string; title: string }[];
  untrackedCode: { filePath: string; symbol: string }[];
}

export function calculateReqCoverage(db: Database.Database): CoverageReport {
  // No requirement↔symbol linking table exists yet (see setup.ts), so every
  // requirement is an orphan and every symbol is untracked. When a
  // `requirement_links` table is introduced, replace these with LEFT JOINs.
  const orphanRequirements = db
    .prepare('SELECT id, title FROM requirements ORDER BY id')
    .all() as { id: string; title: string }[];

  const untrackedCode = (
    db
      .prepare(`
        SELECT f.path, s.name
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        ORDER BY f.path, s.name
      `)
      .all() as { path: string; name: string }[]
  ).map((r) => ({ filePath: r.path, symbol: r.name }));

  return { orphanRequirements, untrackedCode };
}
