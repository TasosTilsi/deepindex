/**
 * Swift's module-to-directory mapping (issue #20).
 *
 * Swift imports a **module**, not a file: `import MyModule` names a target. With SwiftPM that target
 * is a directory — `Sources/MyModule/` by convention — so the file to link is the first source file
 * in it, the same directory-level approximation Go's import gets (and for the same reason: the graph
 * is file-to-file, a module is several files).
 *
 * Everything else stays external, which is most imports in practice: `import Foundation`, `import
 * UIKit`, and every package dependency.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function swiftResolve(repoRoot: string, source: string): string | null {
  // `import MyModule.Sub` names a nested type; the module is the first segment.
  const module = source.split('.')[0];
  if (!module) return null;

  for (const base of [join('Sources', module), module]) {
    const dir = resolve(repoRoot, base);
    if (!existsSync(dir) || !isDir(dir)) continue;
    const first = readdirSync(dir)
      .filter((name) => name.endsWith('.swift'))
      .sort()[0];
    if (first) return join(base, first);
  }
  return null;
}
