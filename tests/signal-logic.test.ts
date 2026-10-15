import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { getSignals } from '../src/health.js';
import { applySignals, computeSignals, parseSignalPairs, SignalUsageError } from '../src/signal.js';

/**
 * The `signal` verb's logic, called directly (issue #21).
 *
 * It used to live inside a commander action behind `process.exit` and `console.log`, reachable only
 * by spawning the CLI in a child process — which v8 cannot instrument, so the largest body in
 * `src/cli.ts` counted as zero covered lines. These tests exercise it in-process: faster than a
 * spawn, able to assert the message, and visible to the coverage gate.
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'deepindex-signal-logic-'));
}

function report(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('parseSignalPairs', () => {
  it('reads key=value pairs, trimming and parsing numbers', () => {
    expect(parseSignalPairs(['tests_pass=148', ' tests_total = 150 '])).toEqual({
      tests_pass: 148,
      tests_total: 150,
    });
    expect(parseSignalPairs([])).toEqual({});
  });

  it('refuses every malformed pair, naming it', () => {
    for (const bad of ['tests_pass', '=5', 'tests_pass=', 'tests_pass=abc']) {
      expect(() => parseSignalPairs([bad])).toThrow(SignalUsageError);
      expect(() => parseSignalPairs([bad])).toThrow(/invalid signal pair/);
    }
  });
});

describe('computeSignals', () => {
  it('normalises command-line pairs into the ratio plus its sentinel', () => {
    const input = computeSignals(['tests_pass=148', 'tests_total=150'], {});
    expect(input.pairs).toEqual({ tests_pass: 148 / 150, tests_total: 1 });
    expect(input.source).toBe('cli');
  });

  it('reads a vitest report and labels it', () => {
    const dir = tempDir();
    try {
      const path = report(
        dir,
        'vitest.json',
        JSON.stringify({
          numTotalTests: 10,
          numPassedTests: 9,
          numFailedTests: 1,
          numPendingTests: 0,
        })
      );
      const input = computeSignals([], { fromVitest: path });
      expect(input.pairs.tests_pass).toBeCloseTo(0.9, 6);
      expect(input.source).toBe('vitest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads an ESLint report as the share of files that fail lint', () => {
    const dir = tempDir();
    try {
      const quiet = report(dir, 'quiet.json', JSON.stringify([{ errorCount: 1, warningCount: 0 }]));
      const noisy = report(dir, 'noisy.json', JSON.stringify([{ errorCount: 1, warningCount: 99 }]));
      const clean = report(dir, 'clean.json', JSON.stringify([{ errorCount: 0, warningCount: 7 }]));

      expect(computeSignals([], { fromEslint: quiet }).pairs.lint_errors).toBe(1);
      // The warning count must not move the value: that was the inversion fixed in #4.
      expect(computeSignals([], { fromEslint: noisy }).pairs.lint_errors).toBe(1);
      expect(computeSignals([], { fromEslint: clean }).pairs.lint_errors).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sums a directory of JUnit reports, and reads a single file', () => {
    const dir = tempDir();
    try {
      const suite = (tests: number, failures: number) =>
        `<testsuite name="a" tests="${tests}" failures="${failures}" errors="0" skipped="0"/>`;
      const reports = join(dir, 'reports');
      mkdirSync(reports);
      writeFileSync(join(reports, 'a.xml'), suite(3, 1));
      writeFileSync(join(reports, 'b.xml'), suite(2, 0));
      writeFileSync(join(reports, 'ignore.txt'), 'not a report');

      const fromDirectory = computeSignals([], { fromJunit: reports });
      expect(fromDirectory.pairs.tests_total).toBe(1);
      expect(fromDirectory.source).toBe('junit');

      const one = report(dir, 'one.xml', suite(4, 0));
      expect(computeSignals([], { fromJunit: one }).pairs.tests_pass).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses two report flags, reset with input, a missing report and an empty one', () => {
    const dir = tempDir();
    try {
      const suite = '<testsuite name="a" tests="1" failures="0" errors="0" skipped="0"/>';
      const one = report(dir, 'one.xml', suite);
      const empty = report(
        dir,
        'empty.xml',
        '<testsuite name="a" tests="0" failures="0" errors="0" skipped="0"/>'
      );
      const emptyDirectory = join(dir, 'none');
      mkdirSync(emptyDirectory);

      expect(() => computeSignals([], { fromVitest: one, fromJunit: one })).toThrow(/one report/);
      expect(() => computeSignals(['tests_pass=1'], {}, true)).toThrow(/--reset cannot be combined/);
      expect(() => computeSignals([], { fromJunit: join(dir, 'gone.xml') })).toThrow(
        /report not found/
      );
      expect(() => computeSignals([], { fromJunit: empty })).toThrow(/contains no tests/);
      expect(() => computeSignals([], { fromJunit: emptyDirectory })).toThrow(
        /contains no \.xml reports/
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a normalisation failure as usage, and a broken report as itself', () => {
    const dir = tempDir();
    try {
      // A denominator without its numerator comes from normaliseSignalPairs, so it is usage.
      expect(() => computeSignals(['tests_total=150'], {})).toThrow(SignalUsageError);
      // A report that cannot be parsed is NOT usage: the CLI prints it and exits 1, as before.
      const broken = report(dir, 'broken.json', '{not json');
      expect(() => computeSignals([], { fromVitest: broken })).not.toThrow(SignalUsageError);
      expect(() => computeSignals([], { fromVitest: broken })).toThrow(SyntaxError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applySignals', () => {
  it('records the pairs with their source, renders them, and clears them on reset', () => {
    const dir = tempDir();
    const db = initDb(join(dir, 'test.db'));
    try {
      const message = applySignals(db, {
        pairs: { tests_pass: 0.5, tests_total: 1 },
        source: 'vitest',
        reset: false,
      });
      expect(message).toBe('recorded 2 signals: tests_pass=0.500, tests_total=1.000');
      expect(getSignals(db).tests_pass).toBeCloseTo(0.5, 6);

      expect(applySignals(db, { pairs: {}, source: 'cli', reset: true })).toBe('cleared 2 signals');
      expect(getSignals(db)).toEqual({});

      // Singular wording, so the output does not read like a machine wrote it.
      applySignals(db, { pairs: { tests_pass: 1 }, source: 'cli', reset: false });
      expect(applySignals(db, { pairs: {}, source: 'cli', reset: true })).toBe('cleared 1 signal');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
