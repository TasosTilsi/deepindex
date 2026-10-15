/**
 * The `requirements import` verb's logic, out of the CLI (issue #21).
 *
 * Same reason as `src/signal.ts`: the body lived inside a commander action behind `process.exit` and
 * `console.log`, so it was reachable only by spawning the real binary — which v8 cannot instrument —
 * and it counted as zero covered lines. It now *returns* the text to print and *throws* where the CLI
 * used to exit.
 *
 * The two error classes are the CLI's own distinction, kept: a bad `--format` or a file that is not
 * there is usage (exit 2), while a file that cannot be parsed or normalised is a runtime failure
 * (exit 1).
 */
import { existsSync, readFileSync } from 'node:fs';
import type { NormalizeReport, RequirementFormat } from './sources.js';
import { normalizeRequirements } from './sources.js';

export const REQUIREMENT_FORMATS: readonly RequirementFormat[] = ['jira', 'github', 'deepindex'];

/** The command was invoked with something it cannot use: the CLI reports it and exits 2. */
export class ImportUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportUsageError';
  }
}

export interface ImportRenderOptions {
  json: boolean;
  dryRun: boolean;
  /** Present only for a written import. */
  format?: string;
  imported?: number;
  atomic?: number;
}

/**
 * Reads and normalises an export. A `--format` the importer does not know, or a path that is not
 * there, throws `ImportUsageError`; anything the parser or normaliser rejects bubbles as itself.
 */
export function loadRequirementsExport(file: string, format: string): NormalizeReport {
  if (!REQUIREMENT_FORMATS.includes(format as RequirementFormat)) {
    throw new ImportUsageError(`invalid --format: ${format}`);
  }
  if (!existsSync(file)) {
    throw new ImportUsageError(`file not found: ${file}`);
  }
  return normalizeRequirements(
    format as RequirementFormat,
    JSON.parse(readFileSync(file, 'utf8'))
  );
}

/** The line (or JSON document) the verb prints, for both the dry run and the written import. */
export function renderImport(report: NormalizeReport, options: ImportRenderOptions): string {
  const payload = {
    imported: options.dryRun ? report.requirements.length : (options.imported ?? 0),
    atomic: options.dryRun ? 0 : (options.atomic ?? 0),
    skipped: report.skipped,
    warnings: report.warnings,
  };
  if (options.json) return JSON.stringify(payload, null, 2);
  if (options.dryRun) {
    return `Would import ${payload.imported} requirements (${report.skipped} skipped).`;
  }
  return `Imported ${payload.imported} requirements (${payload.atomic} atomic statements) from ${options.format} export.`;
}
