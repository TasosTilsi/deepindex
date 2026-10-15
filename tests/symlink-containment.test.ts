import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { readDirSafe } from '../src/graph/walk.js';

/**
 * Symlink containment in every directory walk.
 *
 * A repository is untrusted input. `readdirSync(dir)` returns names, and `statSync` FOLLOWS a
 * symlink, so a repository that commits `ln -s "$HOME/.aws/credentials" src/config.ts` had that
 * file indexed — its bytes read, hashed and parsed — and `retrieve` then read it back into the
 * model's context. The same missing check made `ln -s .. up` recurse: a two-file repository indexed
 * 81 entries, nested forty levels deep (measured before this fix).
 *
 * Skipping symlinks outright is the same default ripgrep takes, and it also removes the only source
 * of a directory cycle. The cost — a deliberately symlinked vendored directory is not indexed — is
 * documented in USAGE.
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'deepindex-symlink-'));
}

describe('readDirSafe', () => {
  it('reports real entries and omits every symlink, files and directories alike', () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, 'real-dir'));
      writeFileSync(join(dir, 'real-file.ts'), 'export const a = 1;\n');
      symlinkSync('/etc/hostname', join(dir, 'link-file.ts'));
      symlinkSync(join(dir, 'real-dir'), join(dir, 'link-dir'));
      symlinkSync('..', join(dir, 'loop'));

      const entries = readDirSafe(dir);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['real-dir', 'real-file.ts']);
      expect(entries.find((e) => e.name === 'real-file.ts')?.isFile).toBe(true);
      expect(entries.find((e) => e.name === 'real-dir')?.isDirectory).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a directory it cannot read instead of throwing', () => {
    expect(readDirSafe('/nowhere/at/all')).toEqual([]);
  });
});

describe('the index walk', () => {
  it('does not follow a symlink out of the repository', async () => {
    const dir = tempDir();
    const outside = join(dir, 'outside.txt');
    const repo = join(dir, 'repo');
    try {
      writeFileSync(outside, 'AWS_SECRET_ACCESS_KEY=not-a-real-key\n');
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'real.ts'), 'export const ok = 1;\n');
      // The attack: a file inside the repository that resolves outside it.
      symlinkSync(outside, join(repo, 'src', 'leak.ts'));

      const db = initDb(join(dir, 'test.db'));
      await buildGraph(db, repo);
      const paths = (
        db.prepare('SELECT path FROM files ORDER BY path').all() as { path: string }[]
      ).map((r) => r.path);
      expect(paths).toEqual(['src/real.ts']);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not recurse through a symlinked directory, so a cycle cannot blow up the walk', async () => {
    const dir = tempDir();
    const repo = join(dir, 'repo');
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
      // `ln -s .. up` inside src → src/up/src/up/... forever. Measured 81 entries for this
      // two-file repository before the fix.
      symlinkSync('..', join(repo, 'src', 'up'));

      const db = initDb(join(dir, 'test.db'));
      await buildGraph(db, repo);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
      expect(count).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
