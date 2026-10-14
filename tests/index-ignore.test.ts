import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Index hygiene (issue #10).
 *
 * The walk skips a hardcoded set of directories and honors no ignore file, so
 * regenerable tool caches and scratch space land in the graph as if they were
 * source. Measured on ai-ready-nx-workspace: 7 `.nx/workspace-data` rows and 20
 * gitignored `tmp/` rows, the latter including a packed copy of deepindex itself.
 *
 * Invariants locked here:
 *   1. the default set covers the regenerable caches (` .nx`, `tmp`, …);
 *   2. a repo can extend the set with `[index] ignore` in .deepindex.toml;
 *   3. a malformed ignore value is ignored, not fatal.
 */
const SRC = 'export const x = 1;\n';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-ignore-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'keep.ts'), SRC);
  return dir;
}

function seed(dir: string, relDir: string): void {
  mkdirSync(join(dir, relDir), { recursive: true });
  writeFileSync(join(dir, relDir, 'noise.ts'), SRC);
}

async function indexedPaths(dir: string, toml?: string): Promise<string[]> {
  if (toml !== undefined) writeFileSync(join(dir, '.deepindex.toml'), toml);
  const db = initDb(join(dir, 'test.db'));
  await buildGraph(db, dir);
  const rows = db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[];
  db.close();
  return rows.map((r) => r.path);
}

describe('index ignore set', () => {
  it('skips regenerable tool caches and scratch dirs by default', async () => {
    const dir = makeRepo();
    try {
      for (const d of ['.nx/workspace-data', '.turbo', '.gradle', 'tmp', 'node_modules/pkg']) {
        seed(dir, d);
      }
      const paths = await indexedPaths(dir);
      expect(paths).toContain('src/keep.ts');
      for (const d of ['.nx/', '.turbo/', '.gradle/', 'tmp/', 'node_modules/']) {
        expect(paths.some((p) => p.startsWith(d))).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honours [index] ignore from .deepindex.toml', async () => {
    const control = makeRepo();
    const configured = makeRepo();
    try {
      for (const dir of [control, configured]) seed(dir, 'vendor-generated');
      const loose = await indexedPaths(control);
      expect(loose).toContain('vendor-generated/noise.ts');

      const tight = await indexedPaths(configured, '[index]\nignore = ["vendor-generated"]\n');
      expect(tight).toContain('src/keep.ts');
      expect(tight).not.toContain('vendor-generated/noise.ts');
    } finally {
      rmSync(control, { recursive: true, force: true });
      rmSync(configured, { recursive: true, force: true });
    }
  });

  it('ignores a malformed ignore value instead of failing the run', async () => {
    const dir = makeRepo();
    try {
      seed(dir, 'tmp');
      const paths = await indexedPaths(dir, '[index]\nignore = [unterminated\n');
      expect(paths).toContain('src/keep.ts');
      expect(paths.some((p) => p.startsWith('tmp/'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
