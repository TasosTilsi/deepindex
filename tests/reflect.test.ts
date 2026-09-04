import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVitestJson, parseEslintJson, parseCoverageJson } from '../src/reflect.js';
import { initDb } from '../src/graph/db.js';
import { recordSignal, getSignals } from '../src/health.js';

describe('reflect', () => {
  describe('parseVitestJson', () => {
    it('extracts pass/fail/skip/total and durationMs from testResults', () => {
      const v = parseVitestJson({
        numTotalTests: 10,
        numPassedTests: 8,
        numFailedTests: 1,
        numPendingTests: 1,
        testResults: [
          { startTime: 0, endTime: 50 },
          { startTime: 0, endTime: 75 },
        ],
      });
      expect(v).toEqual({ pass: 8, fail: 1, skip: 1, total: 10, durationMs: 125 });
    });

    it('uses numPendingTests for skip (not numSkippedTests)', () => {
      const v = parseVitestJson({
        numTotalTests: 5,
        numPassedTests: 4,
        numFailedTests: 0,
        numPendingTests: 1,
        // numSkippedTests present, but should be ignored.
        numSkippedTests: 999,
      });
      expect(v.skip).toBe(1);
    });

    it('throws TypeError if a required counter is missing', () => {
      expect(() =>
        parseVitestJson({
          numTotalTests: 5,
          numFailedTests: 0,
          numPendingTests: 0,
        })
      ).toThrow(TypeError);
    });

    it('returns durationMs=0 when testResults is missing or empty', () => {
      const v = parseVitestJson({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
      });
      expect(v.durationMs).toBe(0);
    });
  });

  describe('parseEslintJson', () => {
    it('sums errorCount and warningCount across an array', () => {
      const v = parseEslintJson([
        { errorCount: 2, warningCount: 3 },
        { errorCount: 0, warningCount: 1 },
      ]);
      expect(v).toEqual({ errors: 2, warnings: 4, total: 6, files: 2 });
    });

    it('throws TypeError on non-array input', () => {
      expect(() => parseEslintJson({ errorCount: 1, warningCount: 0 })).toThrow(TypeError);
    });

    it('throws TypeError if any per-file count is not a number', () => {
      expect(() =>
        parseEslintJson([{ errorCount: 'two', warningCount: 0 }])
      ).toThrow(TypeError);
    });

    it('returns zeros for an empty array', () => {
      const v = parseEslintJson([]);
      expect(v).toEqual({ errors: 0, warnings: 0, total: 0, files: 0 });
    });
  });

  describe('parseCoverageJson', () => {
    it('derives linesPct from statementMap + s hit counts', () => {
      const v = parseCoverageJson({
        'a.ts': {
          statementMap: { s1: { start: { line: 1 } }, s2: { start: { line: 2 } } },
          s: { s1: 1, s2: 0 },
          branchMap: { b1: {}, b2: {} },
          b: { b1: 1, b2: 0 },
          fnMap: { f1: {}, f2: {} },
          f: { f1: 1, f2: 0 },
        },
        'b.ts': {
          statementMap: { s3: { start: { line: 3 } }, s4: { start: { line: 4 } } },
          s: { s3: 1, s4: 0 },
          branchMap: {},
          b: {},
          fnMap: {},
          f: {},
        },
      });
      expect(v.linesPct).toBeCloseTo(0.5, 5);
      expect(v.branchesPct).toBeCloseTo(0.5, 5);
      expect(v.functionsPct).toBeCloseTo(0.5, 5);
    });

    it('returns 1 for all percentages on an empty object', () => {
      const v = parseCoverageJson({});
      expect(v).toEqual({ linesPct: 1, branchesPct: 1, functionsPct: 1 });
    });

    it('throws TypeError on non-object input', () => {
      expect(() => parseCoverageJson(null)).toThrow(TypeError);
      expect(() => parseCoverageJson('nope')).toThrow(TypeError);
      expect(() => parseCoverageJson([])).toThrow(TypeError);
    });
  });

  describe('glue with health signals', () => {
    it('parseCoverageJson.linesPct is retrievable via getSignals after recordSignal', () => {
      const dir = mkdtempSync(join(tmpdir(), 'deepindex-reflect-glue-'));
      const db = initDb(join(dir, 'test.db'));
      const c = parseCoverageJson({
        'a.ts': {
          statementMap: { s1: { start: { line: 1 } } },
          s: { s1: 1 },
          branchMap: {},
          b: {},
          fnMap: {},
          f: {},
        },
      });
      recordSignal(db, 'coverage_lines', c.linesPct, 'coverage');
      const sigs = getSignals(db);
      expect(sigs.coverage_lines).toBe(c.linesPct);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
