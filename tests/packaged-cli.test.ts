import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The artifact that actually ships.
 *
 * Every other CLI test spawns `tsx src/cli.ts`, and CI only type-checks, so `package.json#bin`
 * (`dist/cli.js`) went unexecuted until a stranger installed the tarball. A pre-release review
 * found this and verified the packaged CLI by hand; this is the test that keeps it verified.
 *
 * It is skipped where `dist/` does not exist (a fresh clone before `pnpm build`) rather than
 * building here — CI runs `pnpm build` and then this file, so the artifact is always exercised on
 * the way to a release.
 */
const DIST = resolve(process.cwd(), 'dist', 'cli.js');

function runDist(args: string[]): { code: number; stdout: string } {
  try {
    return { code: 0, stdout: execFileSync('node', [DIST, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? '' };
  }
}

describe.skipIf(!existsSync(DIST))('the packaged CLI (dist/cli.js)', () => {
  it('reports the version and indexes a repository through the published entry point', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-dist-'));
    try {
      const version = runDist(['--version']);
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

      const indexed = runDist(['index', 'fixtures/sample-repo', '--db', join(dir, 't.db')]);
      expect(indexed.code).toBe(0);
      expect(indexed.stdout).toMatch(/indexed \d+ files, \d+ symbols/);
      expect(existsSync(join(dir, 't.db'))).toBe(true);

      // health exits 1 below the repair threshold — the documented contract, through dist.
      const health = runDist(['health', 'fixtures/sample-repo', '--db', join(dir, 't.db')]);
      expect(JSON.parse(health.stdout)).toHaveProperty('score');
      expect([0, 1]).toContain(health.code);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
