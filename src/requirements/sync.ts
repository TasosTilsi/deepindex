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
  return upsertRequirements(db, (Array.isArray(data) ? data : [data]) as Requirement[]);
}

/**
 * Upserts requirements and their atomic statements. The ONE write path (issue #7):
 * the JSON-file verb and every tracker adapter go through it, so the transaction
 * semantics stay in a single place. The explicit child-delete before INSERT OR REPLACE
 * is load-bearing — SQLite's REPLACE delete does not fire FK actions, so atomics would
 * otherwise go stale.
 */
export function upsertRequirements(
  db: Database.Database,
  reqs: Requirement[]
): { imported: number; atomic: number } {
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
