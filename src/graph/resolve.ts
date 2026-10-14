import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const EXT_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

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

  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) {
      return relative(repoRoot, c);
    }
  }
  return null;
}
