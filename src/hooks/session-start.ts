// Phase 6: SessionStart hook — incremental git sync (HOOK-01, ≤5s, deterministic).

import { initDb } from '../graph/db.js';
import { gitSync } from '../git/indexer.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface HookResult {
  ok: boolean;
  message: string;
}

/** SessionStart: sync git history into the knowledge graph. Deterministic, no LLM. */
export function sessionStart(repoPath: string, dbPath = '.ctx.db'): HookResult {
  const absRepo = resolve(repoPath);
  if (!existsSync(absRepo)) return { ok: false, message: `repo not found: ${absRepo}` };
  const db = initDb(dbPath);
  try {
    const r = gitSync(db, absRepo);
    return {
      ok: true,
      message: `git sync: ${r.commitsProcessed} commits, ${r.entitiesInserted} entities inserted`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  } finally {
    db.close();
  }
}
