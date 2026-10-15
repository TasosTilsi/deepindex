import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Install offers to document how to use deepindex, per harness.
 *
 * Wiring the MCP server is not the same as getting value from it: an agent has to know the
 * tools exist and how to phrase a query. So install appends a short marker-guarded section to
 * the repository's agent instructions — CLAUDE.md for Claude Code, AGENTS.md for the others —
 * and asks first, because editing a file a human owns is their call.
 *
 * Invariants locked here:
 *   1. the target follows the harness, and reuses whichever instructions file the repository
 *      already has rather than creating a second convention;
 *   2. it never writes without permission: `--guidance` says yes, `--no-guidance` says no, and
 *      a non-interactive run (no TTY: CI, a pipe) skips it and says how to ask for it;
 *   3. it is marker-guarded, so re-running cannot duplicate the text.
 */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-guidance-'));
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
    // No TTY: this is exactly the non-interactive case a CI run has.
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

describe('install: documenting deepindex for the agent', () => {
  it('writes CLAUDE.md for Claude Code and AGENTS.md for the other harnesses', async () => {
    const claude = tempRepo();
    const codex = tempRepo();
    try {
      const a = await run(['install', '--harness', 'claude-code', '--no-index', '--guidance'], claude);
      expect(a.code).toBe(0);
      expect(readFileSync(join(claude, 'CLAUDE.md'), 'utf8')).toContain('deepindex:retrieval-nudge');
      expect(existsSync(join(claude, 'AGENTS.md'))).toBe(false);

      const b = await run(['install', '--harness', 'codex', '--no-index', '--guidance'], codex);
      expect(b.code).toBe(0);
      expect(readFileSync(join(codex, 'AGENTS.md'), 'utf8')).toContain('deepindex:retrieval-nudge');
      expect(existsSync(join(codex, 'CLAUDE.md'))).toBe(false);
    } finally {
      rmSync(claude, { recursive: true, force: true });
      rmSync(codex, { recursive: true, force: true });
    }
  });

  it('reuses the instructions file the repository already has', async () => {
    const repo = tempRepo();
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, 'AGENTS.md'), '# House rules\n\nExisting content.\n');
      const r = await run(['install', '--harness', 'claude-code', '--no-index', '--guidance'], repo);
      expect(r.code).toBe(0);
      const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('Existing content.');
      expect(agents).toContain('deepindex:retrieval-nudge');
      expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('appends once, however many times install runs', async () => {
    const repo = tempRepo();
    try {
      await run(['install', '--harness', 'codex', '--no-index', '--guidance'], repo);
      const first = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
      await run(['install', '--harness', 'codex', '--no-index', '--guidance'], repo);
      expect(readFileSync(join(repo, 'AGENTS.md'), 'utf8')).toBe(first);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('writes nothing without permission, and a non-interactive run says how to ask', async () => {
    const repo = tempRepo();
    try {
      const off = await run(['install', '--harness', 'claude-code', '--no-index', '--skip-guidance'], repo);
      expect(off.code).toBe(0);
      expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);

      const unattended = await run(['install', '--harness', 'claude-code', '--no-index'], repo);
      expect(unattended.code).toBe(0);
      expect(existsSync(join(repo, 'CLAUDE.md'))).toBe(false);
      expect(unattended.stdout).toMatch(/--guidance/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
