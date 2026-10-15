// Test helper: build a git repo with known history in a temp dir.
// Used by git/mcp/hooks/adapter/dashboard tests instead of a committed fixture
// (a committed fixture can't carry a real .git history).

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Options for {@link createGitFixture}. */
export interface GitFixtureOptions {
  /**
   * Adds two merge commits: one with git's default `Merge …` subject, which the
   * walker skips by design, and one whose subject does not start with `Merge ` —
   * the case the walker used to pass to git as `"<p1> <p2>"` in a single argv
   * element, which fails with `fatal: ambiguous argument` (issue #3).
   */
  withMerge?: boolean;
}

/** Create a temp git repo with a known history. Returns the repo root. */
export function createGitFixture(opts: GitFixtureOptions = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'deepindex-gitfix-'));
  const src = join(root, 'src');
  mkdirSync(src, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);

  writeFileSync(join(src, 'version.ts'), 'export const VERSION = "1.0.0";\n');
  writeFileSync(join(src, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: initial project scaffold']);

  writeFileSync(join(src, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n// FIX: off-by-one in loop counter\n');
  writeFileSync(join(src, 'counter.ts'), 'export function count(n: number): number { let c = 0; for (let i = 0; i <= n; i++) c++; return c; }\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fix: off-by-one error in counter loop']);

  writeFileSync(join(src, 'version.ts'), 'export const VERSION = "2.0.0";\n// DECISION: use ESM over CJS for tree-shaking\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: bump to v2, decision to standardize on ESM']);

  writeFileSync(join(src, 'math.ts'), 'export function add(a: number, b: number): number { return a + b; }\n// BREAKING: add() now returns bigint\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'refactor: breaking change - add() returns bigint']);

  writeFileSync(join(src, 'mul.ts'), 'export function mul(a: number, b: number): number { return a * b; }\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: add mul function']);

  writeFileSync(join(src, 'div.ts'), 'export function div(a: number, b: number): number { return a / b; }\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: add div function']);

  if (opts.withMerge) addMergeCommits(root, src);

  return root;
}

/** Two merges: the skipped default-subject one, and the lowercase-subject one. */
function addMergeCommits(root: string, src: string): void {
  git(root, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(src, 'feature.ts'), 'export const feature = 1;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: work on the feature branch']);
  git(root, ['checkout', '-q', 'main']);
  // Lowercase subject: the `Merge ` guard does not match, so this commit reaches the
  // diff calls and used to be handed to git as a single "<p1> <p2>" argument (#3).
  git(root, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge: integrate feature branch']);

  git(root, ['checkout', '-q', '-b', 'feature2']);
  writeFileSync(join(src, 'feature2.ts'), 'export const feature2 = 2;\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'feat: second feature branch']);
  git(root, ['checkout', '-q', 'main']);
  // git's own default merge subject — the walker skips these on purpose.
  git(root, ['merge', '-q', '--no-ff', 'feature2']);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
