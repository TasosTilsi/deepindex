/**
 * The `signal` verb's logic, out of the CLI (issue #21).
 *
 * It lived inside a commander action that called `process.exit` and `console.log` directly, which
 * put it beyond every test that runs in-process: the CLI is only ever exercised by spawning the real
 * binary in a child process, and v8 cannot instrument a child process, so `src/cli.ts` reported 0 %
 * line coverage while this — the largest body in the file — was invisible to the gate.
 *
 * Here the verb *returns* what should be printed and *throws* `SignalUsageError` where the CLI used
 * to exit 2. Behaviour is unchanged; what changed is that it can be called.
 *
 * Two error classes are kept apart on purpose, as they were in the CLI: a usage problem (bad pair,
 * two report flags, nothing to read) is `SignalUsageError` and exits 2, while a report that cannot be
 * parsed is left to bubble as whatever the parser threw and exits 1.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { parseEslintJson, parseJunitXml, parseVitestJson } from './reflect.js';
import { clearSignals, normaliseSignalPairs, recordSignal } from './health.js';

/** A problem with how the command was invoked: the CLI reports it and exits 2. */
export class SignalUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalUsageError';
  }
}

export interface ReportOptions {
  fromVitest?: string;
  fromEslint?: string;
  fromJunit?: string;
}

export interface SignalInput {
  pairs: Record<string, number>;
  /** Where the numbers came from: `cli`, `vitest`, `eslint` or `junit`. */
  source: string;
}

/** Parses `key=value` arguments. A malformed pair is a usage error, not a partial write. */
export function parseSignalPairs(args: readonly string[]): Record<string, number> {
  const pairs: Record<string, number> = {};
  for (const raw of args) {
    const equals = raw.indexOf('=');
    const key = equals > 0 ? raw.slice(0, equals).trim() : '';
    const rawValue = equals > 0 ? raw.slice(equals + 1).trim() : '';
    const value = Number(rawValue);
    if (!key || rawValue === '' || !Number.isFinite(value)) {
      throw new SignalUsageError(`invalid signal pair: ${raw} (expected key=value)`);
    }
    pairs[key] = value;
  }
  return pairs;
}

/** Reports are untrusted input and are read whole; refuse one that cannot be a test report. */
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

function readReport(path: string): string {
  if (!existsSync(path)) {
    throw new SignalUsageError(`report not found: ${path}`);
  }
  const size = statSync(path).size;
  if (size > MAX_REPORT_BYTES) {
    throw new SignalUsageError(
      `${path} is ${Math.round(size / 1024 / 1024)} MB — larger than the ${MAX_REPORT_BYTES / 1024 / 1024} MB limit for a report`
    );
  }
  return readFileSync(path, 'utf8');
}

/** The pairs one report contributes, and the source label they carry. */
function pairsFromReports(reports: ReportOptions): SignalInput {
  const pairs: Record<string, number> = {};
  let source = 'cli';

  if (reports.fromVitest) {
    source = 'vitest';
    const path = reports.fromVitest;
    const summary = parseVitestJson(JSON.parse(readReport(path)));
    if (summary.total === 0) {
      // The same class as `tests_total=0` on the command line: the input cannot be used.
      throw new SignalUsageError(`${path} contains no tests`);
    }
    pairs.tests_pass = summary.pass;
    pairs.tests_total = summary.total;
  }

  if (reports.fromEslint) {
    source = 'eslint';
    const summary = parseEslintJson(JSON.parse(readReport(reports.fromEslint)));
    // The share of linted files that have an error, not errors / (errors + warnings): the latter
    // made warnings improve the signal and saturated for any error-only report (#4).
    pairs.lint_errors = summary.filesWithErrors;
    pairs.lint_total = Math.max(1, summary.files);
  }

  if (reports.fromJunit) {
    source = 'junit';
    const path = reports.fromJunit;
    if (!existsSync(path)) {
      throw new SignalUsageError(`report not found: ${path}`);
    }
    const files = statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => name.endsWith('.xml'))
          .map((name) => join(path, name))
      : [path];
    if (files.length === 0) {
      throw new SignalUsageError(`${path} contains no .xml reports`);
    }
    let total = 0;
    let pass = 0;
    for (const file of files) {
      const summary = parseJunitXml(readReport(file));
      total += summary.total;
      pass += summary.pass;
    }
    if (total === 0) {
      throw new SignalUsageError(`${path} contains no tests`);
    }
    pairs.tests_pass = pass;
    pairs.tests_total = total;
  }

  return { pairs, source };
}

/**
 * Everything the verb does before touching the store: parse, validate, normalise. Split out so a
 * usage error can be proven to happen BEFORE the database is opened.
 */
export function computeSignals(args: readonly string[], reports: ReportOptions, reset = false): SignalInput {
  const pairs = parseSignalPairs(args);
  const reportFlags = [reports.fromVitest, reports.fromEslint, reports.fromJunit].filter(Boolean);
  if (reportFlags.length > 1) {
    // Two flags would merge two reports into one reading and label the source with whichever ran
    // last. Refuse instead of lying about where the numbers came from.
    throw new SignalUsageError('pass at most one report flag (one report per run)');
  }
  if (reset && (Object.keys(pairs).length > 0 || reportFlags.length > 0)) {
    throw new SignalUsageError('--reset cannot be combined with signals or a report flag');
  }

  const fromReport = pairsFromReports(reports);
  const merged = { ...pairs, ...fromReport.pairs };

  let normalised: Record<string, number>;
  try {
    normalised = normaliseSignalPairs(merged);
  } catch (err) {
    // The CLI exits 2 for a normalisation failure, so it belongs to the same class as a bad pair.
    throw new SignalUsageError(err instanceof Error ? err.message : String(err));
  }

  return {
    pairs: normalised,
    // The report's label when a report supplied the numbers, `cli` otherwise -- what the verb
    // recorded before, and what the stored rows still say.
    source: reportFlags.length > 0 ? fromReport.source : 'cli',
  };
}

/** Records or clears, and returns the line the CLI prints. */
export function applySignals(
  db: Database.Database,
  input: { pairs: Record<string, number>; source: string; reset: boolean }
): string {
  if (input.reset) {
    const cleared = clearSignals(db);
    return `cleared ${cleared} signal${cleared === 1 ? '' : 's'}`;
  }
  const entries = Object.entries(input.pairs);
  for (const [key, value] of entries) recordSignal(db, key, value, input.source);
  const rendered = entries.map(([key, value]) => `${key}=${value.toFixed(3)}`).join(', ');
  return `recorded ${entries.length} signal${entries.length === 1 ? '' : 's'}: ${rendered}`;
}
