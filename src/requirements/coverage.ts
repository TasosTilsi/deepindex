import type Database from 'better-sqlite3';

export interface CoverageReport {
  orphanRequirements: { id: string; title: string }[];
  untrackedCode: { filePath: string; symbol: string }[];
}

export function calculateReqCoverage(db: Database.Database): CoverageReport {
  // requirement_code_links (populated by the build from `@req REQ-XX`
  // annotations in source comments) connects symbols to requirement ids.
  // - orphanRequirements: requirements with NO code link.
  // - untrackedCode: symbols with NO requirement link.
  const orphanRequirements = db
    .prepare(`
      SELECT r.id, r.title FROM requirements r
      WHERE NOT EXISTS (
        SELECT 1 FROM requirement_code_links l WHERE l.req_id = r.id
      )
      ORDER BY r.id
    `)
    .all() as { id: string; title: string }[];

  const untrackedCode = (
    db
      .prepare(`
        SELECT f.path, s.name
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE NOT EXISTS (
          SELECT 1 FROM requirement_code_links l WHERE l.symbol_id = s.id
        )
        ORDER BY f.path, s.name
      `)
      .all() as { path: string; name: string }[]
  ).map((r) => ({ filePath: r.path, symbol: r.name }));

  return { orphanRequirements, untrackedCode };
}
