import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * `deepindex install` as the single onboarding command.
 *
 * It used to write harness wiring and nothing else: no .deepindex.toml, no .gitignore entry
 * for the index artifact, no npm scripts, no index run, no backup, and no guard before
 * replacing a project's Claude hooks. Everything around the wiring lived in a 500-line shell
 * script, which meant the repo's own flags and config keys could drift away from it silently
 * (they did: its pnpm allowlist wrote to a location pnpm 10+ no longer reads).
 *
 * Invariants locked here:
 *   1. one command leaves a repo ready — config, gitignore, scripts, harness wiring, index;
 *   2. it never silently destroys a file it touches: everything is backed up first, and an
 *      unparseable .claude/settings.json stops the run instead of being overwritten;
 *   3. it is idempotent, and it says what it did;
 *   4. --dry-run writes nothing at all.
 */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-install-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2) + '\n');
  return dir;
}

function run(
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const cli = resolve(process.cwd(), 'src/cli.ts');
    const child = spawn(tsxBin, [cli, ...args], {
      cwd,
      env: { ...process.env, DEEPINDEX_MODEL_CACHE_DIR: join(cwd, '.empty-model-cache') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.on('error', (err) =>
      resolveRun({ code: -1, stdout, stderr: stderr + '\n' + err.message })
    );
  });
}

function anyBackupFile(repo: string): string | null {
  const root = join(repo, '.deepindex-backup');
  if (!existsSync(root)) return null;
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  for (const stamp of readdirSync(root)) {
    const settings = join(root, stamp, '.claude', 'settings.json');
    if (existsSync(settings) && statSync(settings).isFile()) return settings;
  }
  return null;
}

describe('install: the whole onboarding', () => {
  it('leaves the repository ready in one command', async () => {
    const repo = tempRepo();
    try {
      const r = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(r.code).toBe(0);

      // config
      const toml = readFileSync(join(repo, '.deepindex.toml'), 'utf8');
      expect(toml).toContain('[health]');
      expect(toml).toContain('[semantic]');
      expect(toml).toContain('[index]');

      // the index artifact must never be committed
      const ignore = readFileSync(join(repo, '.gitignore'), 'utf8');
      expect(ignore).toContain('.deepindex.db');

      // npm scripts, pinned like the harness wiring is
      const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(Object.keys(pkg.scripts)).toEqual(
        expect.arrayContaining(['di:index', 'di:health', 'di:serve', 'di:retrieve'])
      );
      expect(pkg.scripts['di:index']).toMatch(/npx -y deepindex@\d/);

      // harness wiring (the part install always did)
      expect(existsSync(join(repo, '.mcp.json'))).toBe(true);
      expect(existsSync(join(repo, '.claude', 'settings.json'))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps the indentation of a package.json it edits', async () => {
    const repo = tempRepo();
    try {
      // A user-owned file with its own style: rewriting it with 2-space indent would show up as
      // a whole-file diff in their next commit.
      writeFileSync(join(repo, 'package.json'), '{\n    "name": "demo",\n    "version": "1.0.0"\n}\n');
      const r = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(r.code).toBe(0);
      const text = readFileSync(join(repo, 'package.json'), 'utf8');
      expect(text.startsWith('{\n    "name"')).toBe(true);
      expect(text).toContain('    "di:index"');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('indexes the repository unless told not to', async () => {
    const repo = tempRepo();
    try {
      const r = await run(['install', '--harness', 'claude-code'], repo);
      expect(r.code).toBe(0);
      expect(existsSync(join(repo, '.deepindex.db'))).toBe(true);
      expect(r.stdout).toMatch(/health/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('is idempotent: a second run adds nothing and says so', async () => {
    const repo = tempRepo();
    try {
      await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      const ignoreBefore = readFileSync(join(repo, '.gitignore'), 'utf8');
      const tomlBefore = readFileSync(join(repo, '.deepindex.toml'), 'utf8');

      const second = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(second.code).toBe(0);
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(ignoreBefore);
      expect(readFileSync(join(repo, '.deepindex.toml'), 'utf8')).toBe(tomlBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('backs up an existing harness config before replacing its hooks', async () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, '.claude'), { recursive: true });
      const original = JSON.stringify({ hooks: { SessionStart: 'my own hook' }, keep: true }, null, 2) + '\n';
      writeFileSync(join(repo, '.claude', 'settings.json'), original);

      const r = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(r.code).toBe(0);
      // The user's own hook for a replaced event is called out, not silently dropped.
      expect(r.stdout + r.stderr).toMatch(/SessionStart/);

      const backup = anyBackupFile(repo);
      expect(backup).not.toBeNull();
      expect(readFileSync(backup!, 'utf8')).toBe(original);

      const after = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')) as {
        keep?: boolean;
      };
      expect(after.keep).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an unparseable .claude/settings.json', async () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, '.claude'), { recursive: true });
      const jsonc = '{\n  // my comment\n  "hooks": {}\n}\n';
      writeFileSync(join(repo, '.claude', 'settings.json'), jsonc);

      const r = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/not valid JSON|JSONC/i);
      // Nothing was written at all: the guard runs before the backup and before the wiring,
      // so the file is merely left alone — which is the whole point of refusing.
      expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe(jsonc);
      expect(existsSync(join(repo, '.deepindex-backup'))).toBe(false);
      expect(existsSync(join(repo, '.mcp.json'))).toBe(false);
      expect(existsSync(join(repo, '.deepindex.toml'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes nothing with --dry-run', async () => {
    const repo = tempRepo();
    try {
      const r = await run(['install', '--harness', 'claude-code', '--dry-run'], repo);
      expect(r.code).toBe(0);
      for (const rel of ['.deepindex.toml', '.gitignore', '.mcp.json', '.claude', '.deepindex.db']) {
        expect(existsSync(join(repo, rel)), `${rel} must not be created`).toBe(false);
      }
      expect(r.stdout).toMatch(/dry-run/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The guidance file (CLAUDE.md / AGENTS.md) has its own suite: tests/install-guidance.test.ts.
});
