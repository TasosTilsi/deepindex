import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { getHealth } from '../src/health.js';
import type Database from 'better-sqlite3';

/**
 * Health report honesty (issue #9).
 *
 * The issue list is bounded on purpose — a large monorepo can carry thousands of
 * rows and neither the CLI output nor the repair prompt should balloon. But the
 * report must not *look* complete: it has to state how many issues exist, how
 * many the returned page left out, and give consumers that cannot page (the
 * repair LLM prompt, the adapter's injected context, the dashboard) a summary of
 * the whole set rather than a silently short list.
 */

function writeFixture(dir: string, brokenCount: number): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < brokenCount; i++) {
    // Same missing target in every file: the summary groups by (type, message),
    // so this is what "one group of N" looks like in practice.
    writeFileSync(
      join(dir, 'src', `f${i}.ts`),
      `import { x } from './gone';\nexport const f${i} = x;\n`
    );
  }
}

async function buildFixture(brokenCount: number): Promise<{ db: Database.Database; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-health-report-'));
  writeFixture(dir, brokenCount);
  const db = initDb(join(dir, 'test.db'));
  await buildGraph(db, dir);
  return { db, dir };
}

function runCli(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const child = spawn(tsxBin, ['src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
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

describe('health report honesty', () => {
  it('reports the true total while returning a bounded page', async () => {
    const { db, dir } = await buildFixture(5);
    try {
      const page = getHealth(db, { issueLimit: 2 });
      expect(page.issues).toHaveLength(2);
      expect(page.issuesTotal).toBeGreaterThanOrEqual(5);
      expect(page.issuesTruncated).toBe(page.issuesTotal - 2);

      const nextPage = getHealth(db, { issueLimit: 2, issueOffset: 2 });
      expect(nextPage.issuesTotal).toBe(page.issuesTotal);
      expect(nextPage.issuesTruncated).toBe(page.issuesTotal - 4);
      // Compare the pages, not one element: with five identical broken imports the first issue of
      // each page differs only in `location`, so `issues[0]` was never a real difference.
      const locations = (report: { issues: { location?: string }[] }) =>
        report.issues.map((issue) => issue.location);
      expect(locations(nextPage)).not.toEqual(locations(page));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not truncate a small report, and says so', async () => {
    const { db, dir } = await buildFixture(2);
    try {
      const report = getHealth(db);
      expect(report.issuesTruncated).toBe(0);
      expect(report.issues.length).toBe(report.issuesTotal);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summarises issue groups over the full set, not just the returned page', async () => {
    const { db, dir } = await buildFixture(5);
    try {
      const report = getHealth(db, { issueLimit: 1 });
      expect(report.issues).toHaveLength(1);
      const broken = report.issueSummary.find((g) => g.type === 'broken_import');
      expect(broken?.count).toBe(5);
      expect(report.issueSummary[0].count).toBeGreaterThanOrEqual(broken?.count ?? 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('cli', { timeout: 60_000 }, () => {
    let dir: string;
    let repoPath: string;
    let dbPath: string;

    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'deepindex-health-cli-'));
      // A throwaway repo, not the shared sample fixture: this suite must not
      // depend on — or interfere with — state another suite also walks.
      repoPath = join(dir, 'repo');
      writeFixture(repoPath, 5);
      dbPath = join(dir, 'cli.db');
      const indexed = await runCli(['index', repoPath, '--db', dbPath]);
      expect(indexed.code).toBe(0);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('pages the JSON report and keeps the total honest', async () => {
      const r = await runCli(['health', repoPath, '--db', dbPath, '--issues-limit', '1']);
      // The throwaway repository is deliberately broken, so health exits 1 (below repair_below).
      expect(r.code).toBe(1);
      const report = JSON.parse(r.stdout);
      expect(report.issues).toHaveLength(1);
      expect(report.issuesTotal).toBeGreaterThan(1);
      expect(report.issuesTruncated).toBe(report.issuesTotal - 1);
    });

    it('pages with --issues-offset, and clamps past the end', async () => {
      const first = JSON.parse(
        (await runCli(['health', repoPath, '--db', dbPath, '--issues-limit', '2'])).stdout
      );
      const next = JSON.parse(
        (await runCli(['health', repoPath, '--db', dbPath, '--issues-limit', '2', '--issues-offset', '2']))
          .stdout
      );
      expect(next.issuesTotal).toBe(first.issuesTotal);
      expect(next.issues[0]).not.toEqual(first.issues[0]);

      // Past the end: an empty page, nothing claimed as truncated, the total still true.
      const beyond = JSON.parse(
        (await runCli(['health', repoPath, '--db', dbPath, '--issues-offset', '999'])).stdout
      );
      expect(beyond.issues).toEqual([]);
      expect(beyond.issuesTruncated).toBe(0);
      expect(beyond.issuesTotal).toBe(first.issuesTotal);
    });

    it('rejects a negative limit with exit 2', async () => {
      const r = await runCli(['health', repoPath, '--db', dbPath, '--issues-limit', '-1']);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('--issues-limit');
    });
  });
});
