import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const EXT_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * TypeScript`s NodeNext convention writes the EMITTED extension in the
 * specifier (`./db.js`) while the source on disk is `db.ts`. These pairs map
 * that back. Applied only AFTER the literal candidates, so a real file always
 * wins over a mapped one (issue #16).
 */
const TS_EXT_REWRITE = [
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx', '.ts']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
] as const;

/**
 * Longest suffix first, so `./helper.mjs` is never matched by the `.js` rule.
 * Sorting here (rather than relying on the literal order above) keeps the
 * correctness of the mapping independent of how the table is authored.
 */
const TS_EXT_REWRITE_BY_LENGTH = [...TS_EXT_REWRITE].sort(
  (a, b) => b[0].length - a[0].length
);

/**
 * A specifier that cannot have a target inside this repository: a node:
 * builtin, a bare package id, or a workspace alias. Such an import is
 * EXTERNAL - legitimately absent from the in-repo graph, and therefore not
 * a broken import (issue #8). The rule lives here so exactly one place
 * owns it.
 */
export function isExternalSpecifier(importSource: string): boolean {
  return !importSource.startsWith('.') && !importSource.startsWith('/');
}

export function resolveImport(
  repoRoot: string,
  fromFile: string,
  importSource: string,
  knownFiles: ReadonlyArray<{ absPath: string }>
): string | null {
  // External / bare module — not resolvable in our graph (see isExternalSpecifier).
  if (isExternalSpecifier(importSource)) return null;

  const fromAbs = resolve(repoRoot, fromFile);
  const fromDir = dirname(fromAbs);
  const candidates: string[] = [];

  // 1. As-is
  candidates.push(resolve(fromDir, importSource));
  // 2. With extensions
  for (const ext of EXT_TRY) {
    candidates.push(resolve(fromDir, importSource + ext));
  }
  // 3. As directory with /index
  for (const ext of EXT_TRY) {
    candidates.push(resolve(fromDir, importSource, 'index' + ext));
  }

  // NodeNext source-side mapping, appended so every literal candidate above
  // is probed first (issue #16).
  const tsRewrite = TS_EXT_REWRITE_BY_LENGTH.find(([emittedExt]) =>
    importSource.endsWith(emittedExt)
  );
  if (tsRewrite) {
    const base = importSource.slice(0, -tsRewrite[0].length);
    for (const ext of tsRewrite[1]) {
      candidates.push(resolve(fromDir, base + ext));
    }
  }

  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      return relative(repoRoot, c);
    }
  }
  return null;
}
