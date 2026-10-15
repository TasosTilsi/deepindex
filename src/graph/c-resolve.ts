/**
 * The C family's `#include "..."` mapping (issue #20).
 *
 * A quoted include names a file relative to the including file, and then wherever the build's `-I`
 * flags point. Only the first is knowable from the tree, so the repository root and a conventional
 * `include/` are tried as well, and a specifier none of them matches returns null: the caller
 * classifies it as external rather than broken. Reporting it broken would fill the health report
 * with false positives for every header that lives behind an include directory.
 *
 * Angle-bracket includes (`<stdio.h>`) are system headers by definition and never reach here.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function cResolve(repoRoot: string, fromFile: string, source: string): string | null {
  for (const candidate of [join(dirname(fromFile), source), source, join('include', source)]) {
    if (isFile(resolve(repoRoot, candidate))) return candidate;
  }
  return null;
}
