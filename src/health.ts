// Phase 2: Health scoring + signal store + .deepindex.toml config loader.
// No CLI, no env reads, no module-level singletons. Pure functions of `db` and
// optional config.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HealthConfig, HealthDims, HealthReport, HealthIssue, IssueGroup } from './types.js';

export const DEFAULT_HEALTH_CONFIG: HealthConfig = { repairBelow: 80 };
/** Issues a report returns by default; the true total is always reported (#9). */
export const DEFAULT_ISSUE_LIMIT = 100;
/** Distinct issue groups kept in the summary (#9). */
export const ISSUE_SUMMARY_GROUPS = 10;

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

/**
 * Stores one health signal.
 *
 * CONTRACT (issue #12): `value` is a RATIO in [0,1], not a count — it is enforced
 * below, and the reader consumes it directly. Keys the score reads:
 * `tests_pass`, `tests_total`, `lint_errors`, `lint_total`.
 *
 * `tests_total` and `lint_total` are accepted for compatibility and otherwise
 * ignored: since the value cannot exceed 1, the reader has no denominator to
 * divide by. A writer that has counts must divide them itself (and may record
 * `1.0` under the partner key for older readers). Recording any other key is
 * allowed but has no effect on the score — `coverage_lines` is the live example.
 */
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

/** Numerator/denominator pairs the score understands. */
const SIGNAL_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['tests_pass', 'tests_total'],
  ['lint_errors', 'lint_total'],
];

/**
 * Turns CLI input into what the store holds (issues #4 and #12): values are RATIOS in
 * [0,1]. A numerator given with its partner is divided by it; a numerator given alone
 * is already a ratio. The partner key is always written as the sentinel 1.0, so a reader
 * that still divides by it — including 0.3.4 and earlier — gets the same answer.
 * Unknown keys pass through untouched: recorded, and inert for the score.
 */
export function normaliseSignalPairs(pairs: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [numerator, denominator] of SIGNAL_PAIRS) {
    const n = pairs[numerator];
    const d = pairs[denominator];
    if (n === undefined) {
      if (d !== undefined) {
        throw new TypeError(denominator + ' without ' + numerator);
      }
      continue;
    }
    if (d !== undefined) {
      if (d <= 0) throw new TypeError(denominator + ' must be greater than 0');
      out[numerator] = n / d;
    } else {
      out[numerator] = n;
    }
    const value = out[numerator];
    if (value < 0 || value > 1) {
      throw new TypeError(numerator + ' must be in [0,1] when no ' + denominator + ' is given');
    }
    out[denominator] = 1.0;
  }
  for (const [key, value] of Object.entries(pairs)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/** Deletes every stored signal. Returns how many rows were removed. */
export function clearSignals(db: Database.Database): number {
  const info = db.prepare('DELETE FROM health_signals').run();
  return info.changes;
}

export function getSignals(db: Database.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of selectAllSignals(db)) {
    out[row.key] = row.value;
  }
  return out;
}

export function loadConfig(repoPath: string): HealthConfig {
  const tomlPath = join(repoPath, '.deepindex.toml');
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
  opts: {
    config?: HealthConfig;
    now?: number;
    /** Maximum issues to return (default DEFAULT_ISSUE_LIMIT). */
    issueLimit?: number;
    /** Issues to skip, for paging the report (default 0). */
    issueOffset?: number;
  } = {}
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
  const externalImportsRow = db
    .prepare(`SELECT COUNT(*) AS c FROM imports WHERE external = 1`)
    .get() as { c: number };
  const brokenImportsRow = db
    .prepare(`SELECT COUNT(*) AS c FROM imports WHERE resolved = 0`)
    .get() as { c: number };
  const totalImports = totalImportsRow.c;
  /**
   * In-repo imports only. An external specifier (node builtin, package id,
   * workspace alias) can never have a target here, so keeping it in the
   * denominator dilutes the ratio and hides genuinely broken internal
   * imports (issue #8). Broken imports are relative by construction.
   */
  const inRepoImports = Math.max(0, totalImports - externalImportsRow.c);
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
  if (inRepoImports === 0) {
    // Nothing internal to check: neutral, like any dimension without data.
    consistency = 0.5;
  } else {
    consistency = clamp01(1 - brokenImports / inRepoImports);
  }

  const signals = getSignals(db);
  // Per CONTEXT: coverage = tests_rate * lint_factor; a missing factor is neutral.
  // Issue #12: the stored value is already the ratio (recordSignal enforces
  // [0,1]), so the numerator alone is enough. Requiring the `_total` partner made
  // a lone `tests_pass` move confidence while silently leaving coverage at 0.25.
  const testsPass = signals.tests_pass;
  const testsRate = typeof testsPass === 'number' ? clamp01(testsPass) : 0.5;
  const lintErrors = signals.lint_errors;
  const lintFactor = typeof lintErrors === 'number' ? clamp01(1 - lintErrors) : 0.5;
  const coverage = clamp01(testsRate * lintFactor);

  const importsResolvedRate =
    inRepoImports === 0 ? 0.5 : clamp01(1 - brokenImports / inRepoImports);
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
  // Issue #9: bound the page, never the truth. The grouping runs over the full
  // set so a consumer that cannot page (repair prompt, adapter context,
  // dashboard) still sees the shape of the problem instead of a short list.
  const issuesTotal = issues.length;
  const issueSummary = summariseIssues(issues);
  const issueLimit = Math.max(0, opts.issueLimit ?? DEFAULT_ISSUE_LIMIT);
  const issueOffset = Math.max(0, opts.issueOffset ?? 0);
  const page = issues.slice(issueOffset, issueOffset + issueLimit);
  const issuesTruncated = Math.max(0, issuesTotal - (issueOffset + page.length));

  const dimensions: HealthDims = { freshness, consistency, coverage, confidence };
  return {
    score,
    dimensions,
    issues: page,
    issuesTotal,
    issuesTruncated,
    issueSummary,
  };
}

/** Counts issues by (type, message), most frequent first, top N kept. */
function summariseIssues(issues: HealthIssue[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const issue of issues) {
    const key = `${issue.type}\u0000${issue.message}`;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { type: issue.type, message: issue.message, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, ISSUE_SUMMARY_GROUPS);
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
