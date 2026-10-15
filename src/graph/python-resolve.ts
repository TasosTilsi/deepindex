/**
 * Python's specifier-to-file mapping (issue #20).
 *
 * Python has no `import x from './x'`. A specifier is either a dotted package path — `import
 * pkg.mod`, resolved against whatever roots are on `sys.path`, which for a repository means its
 * root and, in a `src/` layout, `src` — or a relative one, where each leading dot climbs one
 * package from the importing file. Neither the TypeScript resolver (it needs a leading `./`) nor a
 * blanket "external" verdict can express that, which is why Python produced no import rows and no
 * edges at all before this.
 *
 * A miss is not a verdict: `import os` and `from fastapi import FastAPI` name no file here and the
 * caller classifies them as external. A *relative* miss is different — it points inside the
 * package by construction — and the caller counts those as broken.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Where an absolute specifier is looked up: the repository root, then a `src/` layout. */
const ABSOLUTE_ROOTS = ['.', 'src'];

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The repo-relative path an import names, or null when nothing in the tree matches.
 *
 * Both a module (`pkg/mod.py`) and a package (`pkg/__init__.py`) are candidates, in that order,
 * because Python resolves a dotted path to whichever exists.
 */
export function pythonResolve(repoRoot: string, fromFile: string, source: string): string | null {
  const dots = (/^\.+/.exec(source)?.[0] ?? '').length;
  const parts = source.slice(dots).split('.').filter(Boolean);

  const bases: string[] = [];
  if (dots > 0) {
    // One dot is the importing file's own directory; every further dot climbs one package.
    let dir = dirname(fromFile);
    for (let level = 1; level < dots; level += 1) dir = dirname(dir);
    bases.push(dir);
  } else {
    bases.push(...ABSOLUTE_ROOTS);
  }

  for (const base of bases) {
    const stem = parts.length > 0 ? join(base, ...parts) : base;
    for (const candidate of [`${stem}.py`, join(stem, '__init__.py')]) {
      if (isFile(resolve(repoRoot, candidate))) return candidate;
    }
  }
  return null;
}
