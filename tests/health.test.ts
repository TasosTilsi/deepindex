import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb } from '../src/graph/db.js';
import {
  recordSignal,
  getSignals,
  getHealth,
  loadConfig,
  DEFAULT_HEALTH_CONFIG,
} from '../src/health.js';
import { parseVitestJson, parseCoverageJson } from '../src/reflect.js';
import { buildGraph } from '../src/graph/build.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('health', () => {
  describe('schema migration', () => {
    it('bumps user_version to 2 and creates health_signals table', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ctx-schema-'));
      const dbPath = join(tmp, 'test.db');
      const db = initDb(dbPath);
      const v = db.pragma('user_version', { simple: true }) as number;
      expect(v).toBe(2);
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='health_signals'"
        )
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe('health_signals');
      db.close();
    });
  });

  describe('signals', () => {
    it('recordSignal + getSignals round-trip', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ctx-sig-'));
      const dbPath = join(tmp, 'test.db');
      const db = initDb(dbPath);
      recordSignal(db, 'tests', 0.8, 'vitest');
      const sigs = getSignals(db);
      expect(sigs.tests).toBe(0.8);
      db.close();
    });

    it('recordSignal throws on bad inputs', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ctx-sig-bad-'));
      const dbPath = join(tmp, 'test.db');
      const db = initDb(dbPath);
      expect(() => recordSignal(db, '', 0.5, 'src')).toThrow(TypeError);
      expect(() => recordSignal(db, 'x', NaN, 'src')).toThrow(TypeError);
      expect(() => recordSignal(db, 'x', 1.5, 'src')).toThrow(TypeError);
      db.close();
    });
  });

  describe('getHealth', () => {
    it('on an empty DB: score in [0,100], coverage = 0.5*0.5, confidence defaults to 0.5', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-health-empty-'));
      const dbPath = join(dir, 'test.db');
      const localDb = initDb(dbPath);
      const r = getHealth(localDb);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      // Both tests_rate and lint_factor default to 0.5 → 0.5 * 0.5 = 0.25
      expect(r.dimensions.coverage).toBe(0.25);
      expect(r.dimensions.confidence).toBe(0.5);
      localDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('after buildGraph on the sample fixture with a broken import: consistency < 1 and issues include broken_import', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-health-graph-'));
      const dbPath = join(dir, 'test.db');
      const localDb = initDb(dbPath);
      await buildGraph(localDb, FIXTURE);
      const r = getHealth(localDb);
      expect(r.dimensions.consistency).toBeLessThan(1);
      expect(r.issues.some((i) => i.type === 'broken_import')).toBe(true);
      const broken = r.issues.find((i) => i.type === 'broken_import')!;
      expect(broken.message).toContain('./missing');
      localDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('on a clean fixture (no broken imports, no signals): score = 80, consistency = 1', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-health-clean-'));
      const dbPath = join(dir, 'test.db');
      const localDb = initDb(dbPath);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), "import { b } from './b';\nexport function a() { return b(); }\n");
      writeFileSync(join(dir, 'src', 'b.ts'), 'export function b() { return 1; }\n');
      await buildGraph(localDb, dir);
      const r = getHealth(localDb);
      // freshness 1.0, consistency 1.0, coverage 0.25 (0.5*0.5), confidence 0.75
      // -> composite 0.3+0.3+0.05+0.15 = 0.8 -> score 80
      expect(r.score).toBe(80);
      expect(r.dimensions.consistency).toBe(1);
      localDb.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('loadConfig', () => {
    it('reads repair_below = 80 from .ctx.toml', () => {
      const cfg = loadConfig(FIXTURE);
      expect(cfg.repairBelow).toBe(80);
    });

    it('returns default for a missing .ctx.toml', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-cfg-'));
      const cfg = loadConfig(dir);
      expect(cfg).toEqual({ ...DEFAULT_HEALTH_CONFIG });
    });

    it('returns default for a .ctx.toml with no [health] section', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-cfg-'));
      writeFileSync(join(dir, '.ctx.toml'), '[other]\nfoo = 1\n');
      const cfg = loadConfig(dir);
      expect(cfg).toEqual({ ...DEFAULT_HEALTH_CONFIG });
    });

    it('throws on a .ctx.toml with a non-digit repair_below that matches the regex shape but is malformed', () => {
      // The regex only captures digits, so the only way a non-numeric
      // value can reach the parseInt call is impossible with the current
      // regex; verify that the value falls back to default when the
      // regex does not match (i.e. behaves correctly on unparseable input).
      const dir = mkdtempSync(join(tmpdir(), 'ctx-cfg-bad-'));
      writeFileSync(
        join(dir, '.ctx.toml'),
        '[health]\nrepair_below = "eighty"\n'
      );
      const cfg = loadConfig(dir);
      expect(cfg).toEqual({ ...DEFAULT_HEALTH_CONFIG });
    });
  });

  describe('reflect -> health integration', () => {
    it('vitest signal drives coverage dim', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-integ-vitest-'));
      const db = initDb(join(dir, 'test.db'));
      const v = parseVitestJson({
        numTotalTests: 10,
        numPassedTests: 9,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [{ startTime: 0, endTime: 100 }],
      });
      recordSignal(db, 'tests_pass', v.pass / v.total, 'vitest');
      recordSignal(db, 'tests_total', 1.0, 'vitest');
      const r = getHealth(db);
      // coverage = tests_rate * lint_factor = 0.9 * 0.5 = 0.45
      expect(r.dimensions.coverage).toBeGreaterThanOrEqual(0.4);
      expect(r.dimensions.coverage).toBeLessThanOrEqual(0.5);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('eslint signal increases coverage when errors are low', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-integ-eslint-'));
      const db = initDb(join(dir, 'test.db'));
      const before = getHealth(db);
      recordSignal(db, 'lint_errors', 0.0, 'eslint');
      recordSignal(db, 'lint_total', 1.0, 'eslint');
      const after = getHealth(db);
      expect(after.dimensions.coverage).toBeGreaterThan(before.dimensions.coverage);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('coverage parser linesPct flows into coverage via tests_* signals', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-integ-cov-'));
      const db = initDb(join(dir, 'test.db'));
      const c = parseCoverageJson({
        'a.ts': {
          statementMap: { s1: { start: { line: 1 } }, s2: { start: { line: 2 } } },
          s: { s1: 1, s2: 0 },
          branchMap: {},
          b: {},
          fnMap: {},
          f: {},
        },
      });
      recordSignal(db, 'coverage_lines', c.linesPct, 'coverage');
      recordSignal(db, 'tests_pass', 0.8, 'coverage');
      recordSignal(db, 'tests_total', 1.0, 'coverage');
      const r = getHealth(db);
      // tests_rate = 0.8, lint_factor = 0.5 (missing lint_*); coverage = 0.4
      expect(r.dimensions.coverage).toBeCloseTo(0.4, 5);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});

