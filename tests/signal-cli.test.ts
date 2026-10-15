import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initDb } from '../src/graph/db.js';
import { getHealth, getSignals } from '../src/health.js';
import { parseJunitXml } from '../src/reflect.js';

/**
 * The `signal` verb (issue #4).
 *
 * The score reads four keys from `health_signals`, but nothing could write them: the
 * coverage and confidence dimensions were pinned at their neutral fallbacks, capping
 * the score at 80 (the default repair_below) with no headroom, which in turn made
 * sessionStart's auto-repair fire on repos that were fine.
 *
 * The store holds RATIOS in [0,1] (recordSignal enforces it), so the CLI divides counts
 * itself and writes the partner key as the sentinel 1.0 — an older reader that still
 * divides by it then gets the same answer.
 */
const JUNIT_A = '<testsuite name="a" tests="10" failures="1" errors="1" skipped="1"><testcase/></testsuite>';
const JUNIT_B = '<testsuite name="b" tests="5" failures="0" errors="0" skipped="0"><testcase/></testsuite>';

function run(
  args: string[],
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const child = spawn(tsxBin, ['src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
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

function freshDb(dir: string): string {
  const dbPath = join(dir, 'signals.db');
  const db = initDb(dbPath);
  db.close();
  return dbPath;
}

function readSignals(dbPath: string): Record<string, number> {
  const db = initDb(dbPath);
  try {
    return getSignals(db);
  } finally {
    db.close();
  }
}

function readHealth(dbPath: string): ReturnType<typeof getHealth> {
  const db = initDb(dbPath);
  try {
    return getHealth(db);
  } finally {
    db.close();
  }
}

describe('parseJunitXml', () => {
  it('sums the counters across testsuite elements', () => {
    expect(parseJunitXml(JUNIT_A + JUNIT_B)).toEqual({ total: 15, fail: 2, skip: 1, pass: 12 });
  });

  it('ignores the testsuites root counters instead of double counting', () => {
    const xml = `<testsuites tests="99" failures="99">${JUNIT_A}</testsuites>`;
    expect(parseJunitXml(xml).total).toBe(10);
  });

  it('throws when there is no testsuite element', () => {
    expect(() => parseJunitXml('<html/>')).toThrow(TypeError);
  });
});

describe('signal verb', () => {
  it('records counts as the ratio plus the sentinel its partner key needs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const r = await run(['signal', 'tests_pass=148', 'tests_total=150', '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/recorded 2 signals/);

      const signals = readSignals(dbPath);
      expect(signals.tests_pass).toBeCloseTo(148 / 150, 6);
      expect(signals.tests_total).toBe(1);

      // coverage = tests_rate * lint_factor, with the lint factor still neutral
      expect(readHealth(dbPath).dimensions.coverage).toBeCloseTo((148 / 150) * 0.5, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts an already-normalised ratio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const r = await run(['signal', 'tests_pass=0.9', '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(readSignals(dbPath).tests_pass).toBeCloseTo(0.9, 6);
      expect(readHealth(dbPath).dimensions.coverage).toBeCloseTo(0.45, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives lint signals from an ESLint report as the share of files that fail lint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const report = join(dir, 'eslint.json');
      writeFileSync(
        report,
        JSON.stringify([
          { filePath: 'a.ts', errorCount: 1, warningCount: 3 },
          { filePath: 'b.ts', errorCount: 0, warningCount: 0 },
        ])
      );
      const r = await run(['signal', '--from-eslint', report, '--db', dbPath]);
      expect(r.code).toBe(0);
      const signals = readSignals(dbPath);
      // One of the two linted files has an error. The old mapping stored errors/total, which
      // made the value depend on how many warnings surrounded the error.
      expect(signals.lint_errors).toBeCloseTo(0.5, 6);
      expect(signals.lint_total).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a warning count change nothing about the lint signal', async () => {
    // A release review found the mapping inverted: one error with no warnings stored 1.0
    // (lint_factor 0) while the same error beside 99 warnings stored 0.01 (lint_factor 0.99),
    // so a dirtier report scored better and any error-only run saturated. These two reports
    // carry the same single error and must produce the same signal.
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const quiet = join(dir, 'quiet.json');
      const noisy = join(dir, 'noisy.json');
      writeFileSync(quiet, JSON.stringify([{ filePath: 'a.ts', errorCount: 1, warningCount: 0 }]));
      writeFileSync(noisy, JSON.stringify([{ filePath: 'a.ts', errorCount: 1, warningCount: 99 }]));

      expect((await run(['signal', '--from-eslint', quiet, '--db', dbPath])).code).toBe(0);
      const withoutWarnings = readSignals(dbPath).lint_errors;
      expect((await run(['signal', '--from-eslint', noisy, '--db', dbPath])).code).toBe(0);
      const withWarnings = readSignals(dbPath).lint_errors;

      expect(withWarnings).toBeCloseTo(withoutWarnings, 6);
      // And a clean report is zero, so lint_factor stays 1.
      const clean = join(dir, 'clean.json');
      writeFileSync(clean, JSON.stringify([{ filePath: 'a.ts', errorCount: 0, warningCount: 7 }]));
      await run(['signal', '--from-eslint', clean, '--db', dbPath]);
      expect(readSignals(dbPath).lint_errors).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives test signals from a vitest JSON report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const report = join(dir, 'vitest.json');
      writeFileSync(
        report,
        JSON.stringify({
          numTotalTests: 10,
          numPassedTests: 9,
          numFailedTests: 1,
          numPendingTests: 0,
        })
      );
      const r = await run(['signal', '--from-vitest', report, '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(readSignals(dbPath).tests_pass).toBeCloseTo(0.9, 6);
      expect(readHealth(dbPath).dimensions.coverage).toBeCloseTo(0.45, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a vitest report that contains no tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const report = join(dir, 'empty-vitest.json');
      writeFileSync(
        report,
        JSON.stringify({
          numTotalTests: 0,
          numPassedTests: 0,
          numFailedTests: 0,
          numPendingTests: 0,
        })
      );
      const r = await run(['signal', '--from-vitest', report, '--db', dbPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/contains no tests/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sums a directory of JUnit reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const reports = join(dir, 'surefire');
      mkdirSync(reports);
      writeFileSync(join(reports, 'a.xml'), JUNIT_A);
      writeFileSync(join(reports, 'b.xml'), JUNIT_B);

      const r = await run(['signal', '--from-junit', reports, '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(readSignals(dbPath).tests_pass).toBeCloseTo(12 / 15, 6);
      expect(readHealth(dbPath).dimensions.coverage).toBeCloseTo((12 / 15) * 0.5, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears every signal with --reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      await run(['signal', 'tests_pass=0.9', '--db', dbPath]);
      const r = await run(['signal', '--reset', '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/cleared 2 signals/);
      expect(readSignals(dbPath)).toEqual({});
      expect(readHealth(dbPath).dimensions.coverage).toBeCloseTo(0.25, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // One case per test, each with an explicit budget. This used to be six spawns inside a single
  // it(): 4.1s measured against vitest's 5000ms default, which CI=1's v8 coverage pushed over the
  // line, so the branch failed its own CI intermittently. A spawn costs ~0.4s here, so the
  // budget is generous on purpose — and a failure now names the input that broke, not the group.
  const rejectionCases: Array<[string, (dir: string) => string[], RegExp]> = [
    ['a non-numeric pair', () => ['tests_pass=abc'], /invalid signal pair/],
    ['a pair with no value', () => ['tests_pass'], /invalid signal pair/],
    ['a denominator without its numerator', () => ['tests_total=150'], /without tests_pass/],
    ['a zero denominator', () => ['tests_pass=0', 'tests_total=0'], /greater than 0/],
    ['--reset combined with a signal', () => ['--reset', 'tests_pass=1'], /--reset cannot be combined/],
    ['a missing JUnit report', (dir) => ['--from-junit', join(dir, 'nope.xml')], /report not found/],
  ];

  for (const [label, argsFor, pattern] of rejectionCases) {
    it(`rejects ${label} with exit 2`, { timeout: 20_000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
      try {
        const dbPath = freshDb(dir);
        const args = ['signal', ...argsFor(dir).flatMap((a) => [a]), '--db', dbPath];
        const r = await run(args);
        expect(r.code, `expected exit 2 for: ${args.join(' ')}`).toBe(2);
        expect(r.stderr).toMatch(pattern);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('rejects a report that contains no tests', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const dbPath = freshDb(dir);
      const report = join(dir, 'empty.xml');
      writeFileSync(report, '<testsuite name="a" tests="0" failures="0" errors="0" skipped="0"/>');
      const r = await run(['signal', '--from-junit', report, '--db', dbPath]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/no tests/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when there is no index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-signal-'));
    try {
      const r = await run(['signal', 'tests_pass=0.9', '--db', join(dir, 'absent.db')]);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/no index/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
