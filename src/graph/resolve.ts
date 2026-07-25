import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const EXT_TRY = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveImport(
  repoRoot: string,
  fromFile: string,
  importSource: string,
  knownFiles: ReadonlyArray<{ absPath: string }>
): string | null {
  // External / bare module — not resolvable in our graph.
  if (!importSource.startsWith('.')) return null;

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
