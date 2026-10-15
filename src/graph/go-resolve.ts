/**
 * Go's import mapping (issue #20).
 *
 * A Go import names a **package directory**, not a file: `import "example.com/mod/pkg/sub"` is the
 * directory `pkg/sub` inside the module, and the file to link is the package's first source file in
 * path order. The module path itself is declared in `go.mod` (`module example.com/mod`), so it has
 * to be read to tell a standard-library import (`fmt`, `net/http`) from an in-tree one.
 *
 * This is deliberately a directory-level approximation: the graph is file-to-file, and a package is
 * several files. It surfaces the dependency without pretending to know which file the symbol came
 * from.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The module path from go.mod, or null when there is none to read. */
export function goModulePath(repoRoot: string): string | null {
  const goMod = resolve(repoRoot, 'go.mod');
  if (!isFile(goMod)) return null;
  const match = /^\s*module\s+(\S+)/m.exec(readFileSync(goMod, 'utf8'));
  return match?.[1] ?? null;
}

/** True when a specifier is inside this module — `example.com/mod/pkg` for module `example.com/mod`. */
export function goImportIsInModule(modulePath: string, source: string): boolean {
  return source === modulePath || source.startsWith(`${modulePath}/`);
}

/**
 * The repo-relative file that stands for the imported package, or null. Returns null for the
 * standard library and for any other module, which the caller then calls external.
 */
export function goResolve(repoRoot: string, source: string): string | null {
  const modulePath = goModulePath(repoRoot);
  if (!modulePath || !goImportIsInModule(modulePath, source)) return null;

  const remainder = source.slice(modulePath.length).replace(/^\//, '');
  const dir = resolve(repoRoot, remainder);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;

  const first = readdirSync(dir)
    .filter((name) => name.endsWith('.go'))
    .sort()[0];
  if (!first) return null;
  return join(remainder, first);
}
