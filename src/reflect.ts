// Phase 2: Reflect — pure JSON parsers for vitest, eslint, istanbul coverage.
// Each parser accepts `unknown` and returns a strict shape. Throws TypeError on
// missing required fields. No I/O, no env reads.

export interface VitestSummary {
  pass: number;
  fail: number;
  skip: number;
  total: number;
  durationMs: number;
}

export interface EslintSummary {
  errors: number;
  warnings: number;
  total: number;
  files: number;
}

export interface CoverageSummary {
  linesPct: number;
  branchesPct: number;
  functionsPct: number;
}

export function parseVitestJson(json: unknown): VitestSummary {
  if (!json || typeof json !== 'object') {
    throw new TypeError('parseVitestJson: input must be an object');
  }
  const j = json as Record<string, unknown>;
  const total = j.numTotalTests;
  const pass = j.numPassedTests;
  const fail = j.numFailedTests;
  const skip = j.numPendingTests;
  if (typeof total !== 'number' || typeof pass !== 'number' || typeof fail !== 'number' || typeof skip !== 'number') {
    throw new TypeError('parseVitestJson: missing one of numTotalTests/numPassedTests/numFailedTests/numPendingTests');
  }
  let durationMs = 0;
  const tr = j.testResults;
  if (Array.isArray(tr)) {
    for (const r of tr) {
      if (r && typeof r === 'object') {
        const rr = r as Record<string, unknown>;
        if (typeof rr.startTime === 'number' && typeof rr.endTime === 'number') {
          durationMs += rr.endTime - rr.startTime;
        }
      }
    }
  }
  return { pass, fail, skip, total, durationMs };
}

interface EslintResult {
  errorCount: number;
  warningCount: number;
}

export function parseEslintJson(json: unknown): EslintSummary {
  if (!Array.isArray(json)) {
    throw new TypeError('parseEslintJson: top-level must be an array of LintResult');
  }
  let errors = 0;
  let warnings = 0;
  for (const item of json) {
    if (!item || typeof item !== 'object') {
      throw new TypeError('parseEslintJson: each result must be an object');
    }
    const r = item as Partial<EslintResult>;
    if (typeof r.errorCount !== 'number' || typeof r.warningCount !== 'number') {
      throw new TypeError('parseEslintJson: errorCount and warningCount must be numbers');
    }
    errors += r.errorCount;
    warnings += r.warningCount;
  }
  return { errors, warnings, total: errors + warnings, files: json.length };
}

interface IstanbulFileEntry {
  statementMap: Record<string, { start: { line: number } }>;
  s: Record<string, number>;
  branchMap: Record<string, unknown>;
  b: Record<string, number>;
  fnMap: Record<string, unknown>;
  f: Record<string, number>;
}

export function parseCoverageJson(json: unknown): CoverageSummary {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('parseCoverageJson: input must be a non-null object');
  }
  const files = Object.values(json as Record<string, unknown>);
  if (files.length === 0) {
    return { linesPct: 1, branchesPct: 1, functionsPct: 1 };
  }
  let lineTotal = 0;
  let lineHit = 0;
  let brTotal = 0;
  let brHit = 0;
  let fnTotal = 0;
  let fnHit = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const f = file as Partial<IstanbulFileEntry>;
    const sm = f.statementMap ?? {};
    const s = f.s ?? {};
    for (const k of Object.keys(sm)) {
      lineTotal++;
      if ((s[k] ?? 0) > 0) lineHit++;
    }
    const bm = f.branchMap ?? {};
    const b = f.b ?? {};
    brTotal += Object.keys(bm).length;
    for (const k of Object.keys(bm)) {
      if ((b[k] ?? 0) > 0) brHit++;
    }
    const fm = f.fnMap ?? {};
    const fns = f.f ?? {};
    fnTotal += Object.keys(fm).length;
    for (const k of Object.keys(fm)) {
      if ((fns[k] ?? 0) > 0) fnHit++;
    }
  }
  return {
    linesPct: lineTotal === 0 ? 1 : lineHit / lineTotal,
    branchesPct: brTotal === 0 ? 1 : brHit / brTotal,
    functionsPct: fnTotal === 0 ? 1 : fnHit / fnTotal,
  };
}
