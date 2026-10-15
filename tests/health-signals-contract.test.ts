import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { getHealth, recordSignal } from '../src/health.js';
import type Database from 'better-sqlite3';

/**
 * The health signal contract (issue #12).
 *
 * `health_signals.value` is a RATIO in [0,1] — `recordSignal` enforces exactly that.
 * The reader therefore needs only the numerator: `tests_total` and `lint_total` are
 * accepted for compatibility and otherwise ignored.
 *
 * Requiring the partner key was the trap: a lone `tests_pass` raised `confidence`
 * (which reads it alone) while `coverage` stayed at its neutral 0.25, so a working
 * signal looked like it had done nothing. These tests pin the contract so the
 * asymmetry cannot come back, and pin that `coverage_lines` — a key nothing reads —
 * influences no dimension.
 */
function withDb<T>(fn: (db: Database.Database) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-signals-'));
  const db = initDb(join(dir, 'test.db'));
  try {
    return fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('health signal contract', () => {
  it('treats a stored value as the ratio, so a lone tests_pass moves coverage', () => {
    withDb((db) => {
      recordSignal(db, 'tests_pass', 0.9, 'ci');
      const r = getHealth(db);
      // coverage = tests_rate * lint_factor, with the lint factor still neutral 0.5
      expect(r.dimensions.coverage).toBeCloseTo(0.9 * 0.5, 5);
      // confidence = 0.5 * importsResolvedRate + 0.5 * testsPassRate; no imports -> 0.5
      expect(r.dimensions.confidence).toBeCloseTo(0.7, 5);
    });
  });

  it('treats a lone lint_errors as the error share', () => {
    withDb((db) => {
      recordSignal(db, 'lint_errors', 0.2, 'eslint');
      const r = getHealth(db);
      // lint_factor = 1 - 0.2; tests_rate stays neutral 0.5
      expect(r.dimensions.coverage).toBeCloseTo(0.5 * 0.8, 5);
    });
  });

  it('treats the 1.0 sentinel form of the partner key as equivalent', () => {
    withDb((db) => {
      recordSignal(db, 'tests_pass', 0.9, 'ci');
      recordSignal(db, 'tests_total', 1.0, 'ci');
      const r = getHealth(db);
      expect(r.dimensions.coverage).toBeCloseTo(0.45, 5);
    });
  });

  it('combines both factors, and a clean lint run leaves coverage at the test rate', () => {
    withDb((db) => {
      recordSignal(db, 'tests_pass', 0.9, 'ci');
      recordSignal(db, 'lint_errors', 0, 'eslint');
      const r = getHealth(db);
      expect(r.dimensions.coverage).toBeCloseTo(0.9, 5);
    });
  });

  it('does not let coverage_lines influence any dimension', () => {
    withDb((db) => {
      const before = getHealth(db).dimensions;
      recordSignal(db, 'coverage_lines', 0.42, 'coverage');
      const after = getHealth(db).dimensions;
      expect(after).toEqual(before);
    });
  });
});
