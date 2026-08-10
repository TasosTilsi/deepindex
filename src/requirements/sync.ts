import type Database from 'better-sqlite3';
import { z } from 'zod';
import { extractAtomicStatements } from './extractor.js';
import fs from 'node:fs';

export interface Requirement {
  id: string;
  title: string;
  description: string;
  source: string;
  status: 'draft' | 'approved' | 'implemented';
}

export interface AtomicRequirement {
  id: number;
  req_id: string;
  statement: string;
  type: 'modal' | 'bullet' | 'general';
  order: number;
}

export const RequirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  source: z.string(),
  status: z.enum(['draft', 'approved', 'implemented']),
});

export function syncRequirements(db: Database.Database, jsonPath: string): { imported: number; atomic: number } {
  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const data = JSON.parse(raw);

  const reqs = Array.isArray(data) ? data : [data];
  let imported = 0;
  let atomic = 0;

  const insertReq = db.prepare(
    `INSERT OR REPLACE INTO requirements (id, title, description, source, status) VALUES (?, ?, ?, ?, ?)`
  );
  const insertAtomic = db.prepare(
    `INSERT INTO atomic_requirements (req_id, statement, type, "order") VALUES (?, ?, ?, ?)`
  );

  db.transaction(() => {
    for (const item of reqs) {
      if (item.id) {
        db.prepare(`DELETE FROM atomic_requirements WHERE req_id = ?`).run(item.id);
      }
    }

    for (const item of reqs) {
      const parsed = RequirementSchema.parse(item);
      insertReq.run(parsed.id, parsed.title, parsed.description, parsed.source, parsed.status);
      imported++;

      const { statements } = extractAtomicStatements(parsed.description);
      statements.forEach((s, idx) => {
        insertAtomic.run(parsed.id, s.text, s.type, idx + 1);
        atomic++;
      });
    }
  })();

  return { imported, atomic };
}
