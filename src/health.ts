// Phase 2: Health scoring + signal store + .ctx.toml config loader.
// No CLI, no env reads, no module-level singletons. Pure functions of `db` and
// optional config.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HealthConfig, HealthDims, HealthReport, HealthIssue } from './types.js';

export const DEFAULT_HEALTH_CONFIG: HealthConfig = { repairBelow: 80 };

const insertSignal = (db: Database.Database) =>
  db.prepare(
    `INSERT OR REPLACE INTO health_signals (key, value, source, updated_at)
     VALUES (?, ?, ?, ?)`
  );

const selectAllSignals = (db: Database.Database) =>
  db.prepare(`SELECT key, value FROM health_signals`).all() as {
    key: string;
    value: number;
  }[];

export function recordSignal(
  db: Database.Database,
  key: string,
  value: number,
  source: string
): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('recordSignal: key must be a non-empty string');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('recordSignal: value must be a finite number');
  }
  if (value < 0 || value > 1) {
    throw new TypeError('recordSignal: value must be in [0,1]');
  }
  insertSignal(db).run(key, value, source, Date.now());
}

export function getSignals(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of selectAllSignals(db)) {
    out[row.key] = row.value;
  }
  return out;
}

export function loadConfig(repoPath: string): HealthConfig {
  const tomlPath = join(repoPath, '.ctx.toml');
  if (!existsSync(tomlPath)) return { ...DEFAULT_HEALTH_CONFIG };
  let text: string;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch {
    return { ...DEFAULT_HEALTH_CONFIG };
  }
  const sectionMatch = text.match(/\[health\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return { ...DEFAULT_HEALTH_CONFIG };
  const block = sectionMatch[1] ?? '';
  const valueMatch = block.match(/repair_below\s*=\s*(\d+)/);
  if (!valueMatch) return { ...DEFAULT_HEALTH_CONFIG };
  // The regex above guarantees digits, but the contract says we throw on
  // non-numeric values — handle a malformed TOML where someone wrote
  // `repair_below = "eighty"` by attempting parseInt and validating.
  const raw = valueMatch[1] ?? '';
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    throw new TypeError(`loadConfig: non-numeric repair_below value: ${raw}`);
  }
  return { repairBelow: n };
}

export function getHealth(
  db: Database.Database,
  opts: { config?: HealthConfig; now?: number } = {}
): HealthReport {
  const config = opts.config ?? DEFAULT_HEALTH_CONFIG;
  const now = opts.now ?? Date.now();
  const freshnessWindow = now - 24 * 60 * 60 * 1000;

  const totalFilesRow = db.prepare(`SELECT COUNT(*) AS c FROM files`).get() as { c: number };
  const totalFiles = totalFilesRow.c;
  const parsedRecentRow = db
    .prepare(`SELECT COUNT(*) AS c FROM files WHERE parsed_at IS NOT NULL AND parsed_at > ?`)
    .get(freshnessWindow) as { c: number };
  const parsedRecently = parsedRecentRow.c;

  const totalImportsRow = db.prepare(`SELECT COUNT(*) AS c FROM imports`).get() as { c: number };
  const brokenImportsRow = db
    .prepare(`SELECT COUNT(*) AS c FROM imports WHERE resolved = 0`)
    .get() as { c: number };
  const totalImports = totalImportsRow.c;
  const brokenImports = brokenImportsRow.c;

  // Dimensions
  let freshness: number;
  if (totalFiles === 0) {
    freshness = 0.5;
  } else if (parsedRecently === 0) {
    freshness = 0.5;
  } else {
    freshness = clamp01(parsedRecently / totalFiles);
  }

  let consistency: number;
  if (totalImports === 0) {
    consistency = 0.5;
  } else {
    consistency = clamp01(1 - brokenImports / totalImports);
  }

  const signals = getSignals(db);
  // Per CONTEXT: coverage = tests_rate * lint_factor; missing factor -> 0.5
  const testsPass = signals.tests_pass;
  const testsTotal = signals.tests_total;
  let testsRate: number;
  if (typeof testsPass === 'number' && typeof testsTotal === 'number') {
    testsRate = testsPass / Math.max(1, testsTotal);
  } else {
    testsRate = 0.5;
  }
  const lintErrors = signals.lint_errors;
  const lintTotal = signals.lint_total;
  let lintFactor: number;
  if (typeof lintErrors === 'number' && typeof lintTotal === 'number') {
    lintFactor = clamp01(1 - lintErrors / Math.max(1, lintTotal));
  } else {
    lintFactor = 0.5;
  }
  const coverage = clamp01(testsRate * lintFactor);

  const importsResolvedRate =
    totalImports === 0 ? 0.5 : clamp01(1 - brokenImports / totalImports);
  const testsPassRate = typeof testsPass === 'number' ? clamp01(testsPass) : 0.5;
  const confidence = clamp01(0.5 * importsResolvedRate + 0.5 * testsPassRate);

  const composite =
    0.3 * freshness +
    0.3 * consistency +
    0.2 * coverage +
    0.2 * confidence;
  const score = Math.round(composite * 100);

  // Issues
  const issues: HealthIssue[] = [];
  const brokenRows = db
    .prepare(
      `SELECT i.source AS source, f.path AS path
       FROM imports i JOIN files f ON f.id = i.file_id
       WHERE i.resolved = 0`
    )
    .all() as { source: string; path: string }[];
  for (const r of brokenRows) {
    issues.push({
      type: 'broken_import',
      message: `unresolved import: ${r.source}`,
      location: r.path,
    });
  }
  if (coverage < 0.5) {
    issues.push({ type: 'low_coverage', message: 'coverage below 50%' });
  }
  if (confidence < 0.5) {
    issues.push({ type: 'low_confidence', message: 'confidence below 50%' });
  }
  if (issues.length > 100) issues.length = 100;

  const dimensions: HealthDims = { freshness, consistency, coverage, confidence };
  return { score, dimensions, issues };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
