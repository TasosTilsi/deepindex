import type Database from 'better-sqlite3';

export interface CoverageReport {
  orphanRequirements: { id: string; title: string }[];
  untrackedCode: { filePath: string; symbol: string }[];
}

export function calculateReqCoverage(db: Database.Database): CoverageReport {
  // 1. Identify orphan requirements (no linked code)
  // We assume there is a linking table 'requirement_links' (req_id, symbol_id)
  // For this MVP/Phase, if the table doesn't exist, we report all as orphans
  // but let's implement the query assuming it might exist.
  
  const orphans: { id: string; title: string }[] = [];
  try {
    const rows = db.prepare(`
      SELECT r.id, r.title 
      FROM requirements r 
      LEFT JOIN requirement_links rl ON r.id = rl.req_id 
      WHERE rl.req_id IS NULL
    `).all() as { id: string; title: string }[];
    
    for (const row of rows) {
      orphans.push(row);
    }
  } catch (e) {
    // Table might not exist yet in this version
    const allReqs = db.prepare(`SELECT id, title FROM requirements`).all() as { id: string; title: string }[];
    for (const r of allReqs) orphans.push(r);
  }

  // 2. Identify untracked code (no linked requirement)
  const untracked: { filePath: string; symbol: string }[] = [];
  try {
    const rows = db.prepare(`
      SELECT f.path, s.name 
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      LEFT JOIN requirement_links rl ON s.id = rl.symbol_id
      WHERE rl.symbol_id IS NULL
    `).all() as { path: string; name: string }[];
    
    for (const row of rows) {
      untracked.push({ filePath: row.path, symbol: row.name });
    }
  } catch (e) {
    // Fallback: if linking is totally absent, everything is untracked
    const symbols = db.prepare(`
      SELECT f.path, s.name 
      FROM symbols s 
      JOIN files f ON s.file_id = f.id
    `).all() as { path: string; name: string }[];
    for (const s of symbols) untracked.push({ filePath: s.path, symbol: s.name });
  }

  return {
    orphanRequirements: orphans,
    untrackedCode: untracked,
  };
}
