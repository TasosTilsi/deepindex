// Smoke test: end-to-end build → status → retrieve on the fixture.
// Plain tsx script (NOT vitest) — package.json runs it via `tsx tests/smoke.test.ts`.
// Exits 0 on success, 1 on any failure. Mirrors ROADMAP phase-3 criterion #5.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');
const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    // Absolute tsx binary so we can spawn from any cwd (same pattern as tests/cli.test.ts).
    const child = spawn(tsxBin, ['src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.on('error', (err) => resolveRun({ code: -1, stdout, stderr: stderr + '\n' + err.message }));
  });
}

function fail(step: string, stderr: string): never {
  console.error(`smoke: FAILED at "${step}"`);
  if (stderr) console.error(stderr);
  process.exit(1);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-smoke-'));
  const dbPath = join(dir, 'smoke.db');
  try {
    // 1. build
    const build = await run(['build', FIXTURE, '--db', dbPath]);
    if (build.code !== 0) fail('build', build.stderr);

    // 2. status → print health JSON
    const status = await run(['status', FIXTURE, '--db', dbPath]);
    if (status.code !== 0 && status.code !== 1) fail('status', status.stderr);
    let health: { score?: number };
    try {
      health = JSON.parse(status.stdout.trim()) as { score?: number };
    } catch {
      fail('status (stdout not JSON)', status.stdout);
    }
    if (typeof health.score !== 'number') fail('status (no score)', status.stdout);
    console.log(`health: ${status.stdout.trim()}`);

    // 3. retrieve "auth" → print top-K files
    const retrieve = await run(['retrieve', 'auth', '--db', dbPath, '--top-k', '5']);
    if (retrieve.code !== 0) fail('retrieve', retrieve.stderr);
    if (!/\.ts/.test(retrieve.stdout)) fail('retrieve (no .ts files)', retrieve.stdout);
    console.log(retrieve.stdout.trim());

    console.log('smoke ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
