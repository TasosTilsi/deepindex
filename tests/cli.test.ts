import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');
const SERVE_PORT = 17331;

function run(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    // Use the absolute tsx binary so we can spawn from any cwd (avoids
    // pnpm's ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE in tmpdirs without a
    // package.json).
    const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const child = spawn(tsxBin, ['src/cli.ts', ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.on('error', (err) => resolveRun({ code: -1, stdout, stderr: stderr + '\n' + err.message }));
  });
}

describe('cli', { timeout: 30_000 }, () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deepindex-cli-'));
    dbPath = join(dir, 'test.db');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('index indexes the fixture and writes the db', async () => {
    const r = await run(['index', FIXTURE, '--db', dbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/indexed/);
    expect(r.stdout).toMatch(/\d+ files/);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('health emits JSON health after a build', async () => {
    // First build (idempotent if a parallel test already ran).
    await run(['index', FIXTURE, '--db', dbPath]);
    const r = await run(['health', FIXTURE, '--db', dbPath]);
    expect([0, 1]).toContain(r.code);
    const parsed = JSON.parse(r.stdout.trim()) as { score?: number; dimensions?: unknown; issues?: unknown };
    expect(parsed).toHaveProperty('score');
    expect(parsed).toHaveProperty('dimensions');
    expect(parsed).toHaveProperty('issues');
  });

  it('repair prints before:/after: labels after a build', async () => {
    await run(['index', FIXTURE, '--db', dbPath]);
    const r = await run(['repair', FIXTURE, '--db', dbPath]);
    expect([0, 1]).toContain(r.code);
    expect(r.stdout).toContain('before:');
    expect(r.stdout).toContain('after:');
  });

  it('retrieve prints a top file path for the "auth" query', async () => {
    await run(['index', FIXTURE, '--db', dbPath]);
    const r = await run(['retrieve', 'auth', '--db', dbPath, '--top-k', '5']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\.ts/);
  });

  it.skipIf(process.env.CTX_TEST_SKIP_SERVE === '1')(
    'serve responds to POST /context with the AdapterResult JSON',
    async () => {
      await run(['build', FIXTURE, '--db', dbPath]);
      const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
      const child: ChildProcess = spawn(
        tsxBin,
        ['src/cli.ts', 'serve', '--port', String(SERVE_PORT), '--db', dbPath],
        { cwd: process.cwd() }
      );
      try {
        // Wait for "listening" line.
        await new Promise<void>((res, rej) => {
          const onData = (chunk: Buffer) => {
            const s = chunk.toString();
            if (s.includes('listening')) {
              child.stdout?.off('data', onData);
              res();
            }
          };
          child.stdout?.on('data', onData);
          child.once('exit', (code) =>
            rej(new Error(`serve child exited early with code=${code}`))
          );
          setTimeout(() => rej(new Error('serve startup timeout (5s)')), 5000);
        });

        const res = await fetch(`http://127.0.0.1:${SERVE_PORT}/context`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ task: 'auth', repoPath: FIXTURE }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { topFiles?: unknown; neighborhood?: unknown; health?: unknown };
        expect(body).toHaveProperty('topFiles');
        expect(body).toHaveProperty('neighborhood');
        expect(body).toHaveProperty('health');
        expect(Array.isArray(body.topFiles)).toBe(true);
        expect(Array.isArray(body.neighborhood)).toBe(true);
      } finally {
        child.kill('SIGTERM');
        await new Promise<void>((r) => {
          child.once('exit', () => r());
          setTimeout(r, 1500);
        });
      }
    }
  );

  it('build-graph prints a data-flow projection summary after a build', async () => {
    await run(['index', FIXTURE, '--db', dbPath]);
    const r = await run(['build-graph', '--db', dbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Data-flow graph:');
  });

  it('build-graph --json emits a valid projection JSON object', async () => {
    await run(['index', FIXTURE, '--db', dbPath]);
    const r = await run(['build-graph', '--db', dbPath, '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty('tableCount');
    expect(parsed).toHaveProperty('queryCount');
    expect(parsed).toHaveProperty('serviceCount');
    expect(parsed).toHaveProperty('queriesWithoutTables');
    expect(parsed).toHaveProperty('filesWithSqlNoService');
  });

  it('watch prints "invalidated: <relpath>" and exits 0 on SIGTERM', async () => {
    const watchDir = mkdtempSync(join(tmpdir(), 'deepindex-cli-watch-'));
    const watchDb = join(watchDir, 'watch.db');
    try {
      const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
      const cliPath = resolve(process.cwd(), 'src/cli.ts');
      const child: ChildProcess = spawn(
        tsxBin,
        [cliPath, 'watch', '--db', watchDb, '--debounce', '100'],
        { cwd: watchDir }
      );

      let stdout = '';
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      try {
        // Wait for chokidar's initial scan to finish ("watching" signal).
        await new Promise<void>((res, rej) => {
          const onData = (chunk: Buffer) => {
            const s = chunk.toString();
            if (s.includes('watching')) {
              child.stdout?.off('data', onData);
              res();
            }
          };
          child.stdout?.on('data', onData);
          child.once('exit', (code) =>
            rej(new Error(`watch child exited early with code=${code}`))
          );
          setTimeout(() => rej(new Error('watch ready timeout (5s)')), 5000);
        });
        writeFileSync(join(watchDir, 'f.ts'), 'export const a = 1;\n');
        // Give it time to debounce + emit.
        await new Promise((r) => setTimeout(r, 1500));
        // The watcher is rooted at watchDir, so "invalidated: f.ts" is the
        // expected path (D-04).
        expect(stdout).toContain('invalidated: f.ts');
      } finally {
        child.kill('SIGTERM');
        const exitCode: number | null = await new Promise((r) => {
          child.once('exit', (code) => r(code));
          setTimeout(() => r(null), 3000);
        });
        expect(exitCode).toBe(0);
      }
    } finally {
      rmSync(watchDir, { recursive: true, force: true });
    }
  });
});
