import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { langForExt } from '../parser/languages.js';
import type { PackageIndex } from './package-resolve.js';
import { isPackageLanguage, resolvePackagePath } from './package-resolve.js';
import { pythonResolve } from './python-resolve.js';
import { rustResolve } from './rust-resolve.js';
import { rubyResolve } from './ruby-resolve.js';
import { cResolve } from './c-resolve.js';
import { goResolve } from './go-resolve.js';
import { bashResolve, dartResolve, luaResolve } from './relative-resolve.js';

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

/** Per-call resolution context. One object, so adding a language later cannot break
 *  this signature again. */
export interface ResolveContext {
  /** In-tree Java class map, built once per index run (issue #5). */
  packageIndex?: PackageIndex;
  /** The specifier came from an `import static …` declaration. */
  isStatic?: boolean;
}

export function resolveImport(
  repoRoot: string,
  fromFile: string,
  importSource: string,
  knownFiles: ReadonlyArray<{ absPath: string }>,
  ctx: ResolveContext = {}
): string | null {
  // Issue #20: a Python specifier is a package path, not a filesystem path — a leading dot is a
  // package level, not `./`. It must be handled before the relative-candidate logic below, which
  // would otherwise send `..pkg.mod` looking for a file literally named that.
  if (langForExt(extname(fromFile)) === 'python') {
    return pythonResolve(repoRoot, fromFile, importSource);
  }
  // `require_relative` is relative to the file, so it has its own candidate rules — none of the
  // JavaScript extensions below apply.
  if (langForExt(extname(fromFile)) === 'ruby') {
    return rubyResolve(repoRoot, fromFile, importSource);
  }
  // `source ./x.sh` is a plain path, never a module specifier spelled from a root.
  const earlyLanguage = langForExt(extname(fromFile));
  if (earlyLanguage === 'bash' || earlyLanguage === 'sh') {
    return bashResolve(repoRoot, fromFile, importSource);
  }

  // External / bare module — not resolvable in our graph (see isExternalSpecifier),
  // with one exception: for a Java source a non-relative specifier may be an in-tree
  // FQN. Consulted BEFORE any external classification, because in a multi-module Maven
  // repository an in-tree class and a declared artifact can share a prefix. A miss here
  // still returns null, and classifying it stays the caller's decision (issue #5).
  if (isExternalSpecifier(importSource)) {
    if (ctx.packageIndex && isPackageLanguage(langForExt(extname(fromFile)))) {
      return resolvePackagePath(ctx.packageIndex, importSource, ctx.isStatic === true);
    }
    // Issue #20: a Rust path is spelled from a root keyword (`crate::`, `self::`, `super::`) and
    // names an item inside a module; only those three roots can land inside the tree.
    if (langForExt(extname(fromFile)) === 'rust') {
      return rustResolve(repoRoot, fromFile, importSource);
    }
    // A quoted `#include` is relative to the including file, then to whatever `-I` points at. Only
    // the first is knowable here, so a miss returns null and stays external.
    const language = langForExt(extname(fromFile));
    if (language === 'c' || language === 'cpp' || language === 'objc') {
      return cResolve(repoRoot, fromFile, importSource);
    }
    if (language === 'go') return goResolve(repoRoot, importSource);
    if (language === 'lua') return luaResolve(repoRoot, fromFile, importSource);
    if (language === 'dart') return dartResolve(repoRoot, fromFile, importSource);
    return null;
  }

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
