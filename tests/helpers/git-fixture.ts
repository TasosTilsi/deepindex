// Test helper: build a git repo with known history in a temp dir.
// Used by git/mcp/hooks/adapter/dashboard tests instead of a committed fixture
// (a committed fixture can't carry a real .git history).

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Create a temp git repo with a known history. Returns the repo root. */
export function createGitFixture(): string {
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

  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}
