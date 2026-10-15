import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { getHealth } from '../src/health.js';
import type Database from 'better-sqlite3';

/**
 * The upgrade path (issues #8 and #16, and the release reviews that flagged it independently).
 *
 * The import classification is written when a file is parsed, and the incremental indexer skips
 * files whose hash is unchanged. So a store written by an older deepindex keeps the old verdicts
 * forever: an incremental `index` prints "indexed 0 files", re-classifies nothing, and the score
 * stays wrong — while `user_version` has already been bumped, so the store LOOKS migrated. On a
 * real repository that is `consistency` stuck near zero and a score below `repair_below`, which
 * makes sessionStart run the auto-repair pipeline on a repository that is fine.
 *
 * Invariants locked here:
 *   1. opening a store that a schema migration changed marks its stored classifications as stale;
 *   2. the next build re-parses every file once, whatever entry point triggered it, and says so;
 *   3. the marker is consumed, so the pass after that is incremental again;
 *   4. a fresh database is never forced through a pointless full pass.
 */
function repoWithExternalImport(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-upgrade-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'uses-fs.ts'),
    "import { readFileSync } from 'node:fs';\nexport function read(p: string) { return readFileSync(p, 'utf8'); }\n"
  );
  return dir;
}

/** Rewrites the import rows the way pre-#8 code wrote them, then drops the schema version. */
function ageTheStore(db: Database.Database): void {
  db.prepare('UPDATE imports SET resolved = 0, external = 0').run();
  db.pragma('user_version = 6');
}

describe('upgrading a store written by an older deepindex', () => {
  it('re-classifies stale imports on the next build, without --rebuild', async () => {
    const repo = repoWithExternalImport();
    const dbPath = join(repo, '.deepindex.db');
    try {
      const written = initDb(dbPath);
      await buildGraph(written, repo);
      ageTheStore(written);
      written.close();

      // Re-open through the migration path, then build incrementally — the hash cache is intact.
      const upgraded = initDb(dbPath);
      await buildGraph(upgraded, repo);

      const row = upgraded
        .prepare("SELECT resolved, external FROM imports WHERE source = 'node:fs'")
        .get() as { resolved: number; external: number };
      expect(row).toEqual({ resolved: 1, external: 1 });

      const health = getHealth(upgraded);
      expect(health.issues.filter((i) => i.type === 'broken_import')).toHaveLength(0);
      upgraded.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('marks the store stale exactly once, so the following build is incremental again', async () => {
    const repo = repoWithExternalImport();
    const dbPath = join(repo, '.deepindex.db');
    try {
      const written = initDb(dbPath);
      await buildGraph(written, repo);
      ageTheStore(written);
      written.close();

      const upgraded = initDb(dbPath);
      const forced = await buildGraph(upgraded, repo);
      expect(forced.fileCount).toBeGreaterThan(0);

      // The marker is consumed: nothing changed on disk, so this pass parses nothing.
      const incremental = await buildGraph(upgraded, repo);
      expect(incremental.fileCount).toBe(0);
      upgraded.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not force a pass on a brand-new database', async () => {
    const repo = repoWithExternalImport();
    try {
      const db = initDb(join(repo, '.deepindex.db'));
      const first = await buildGraph(db, repo);
      const second = await buildGraph(db, repo);
      expect(first.fileCount).toBeGreaterThan(0);
      expect(second.fileCount).toBe(0);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
