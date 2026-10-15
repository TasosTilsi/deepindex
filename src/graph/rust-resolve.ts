/**
 * Rust's module-path resolution (issue #20).
 *
 * Two rules make Rust unlike the other languages here:
 *
 * 1. **A path names an item, not a file.** `use self::local::Thing;` refers to the type `Thing`
 *    inside the module `local`. The file to link is the longest *prefix* of the path that is a
 *    module (`local.rs`), which is also why a miss is not automatically a verdict — only a path
 *    whose every prefix misses is dangling.
 * 2. **A path is spelled from a root keyword.** `crate::` is the crate root (Cargo puts it in
 *    `src/`), `self::` is the current module's directory, `super::` is its parent, and a leading
 *    `::` belongs to another crate entirely. A bare `a::b` in the 2018 edition is an external crate
 *    unless a module of that name exists, so it is tried and then left to the caller.
 *
 * A module lives at `<path>.rs` or `<path>/mod.rs`.
 */
import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Where a module's CHILDREN live. With Rust 2018 module paths, `src/a.rs` owns `src/a/`, so
 * `self::b` in `src/a.rs` is `src/a/b.rs` — using the file's own directory (as this first did) put
 * it in `src/` and produced either a bogus miss or a WRONG edge. The three files that own their
 * directory are the crate roots and `mod.rs`.
 */
function moduleDir(fromFile: string): string {
  const name = basename(fromFile);
  const dir = dirname(fromFile);
  if (name === 'mod.rs' || name === 'lib.rs' || name === 'main.rs') return dir;
  return join(dir, name.replace(/\.rs$/, ''));
}

/**
 * The crate root, for `crate::`. It is the `src/` beside the nearest `Cargo.toml`, not a hardcoded
 * `src` — a Cargo workspace keeps its members under `crates/<name>/src`, and `crate::` there means
 * that member's root.
 */
function crateRoot(repoRoot: string, fromFile: string): string {
  let dir = dirname(fromFile);
  for (;;) {
    if (isFile(resolve(repoRoot, dir, 'Cargo.toml'))) return join(dir, 'src');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'src';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function moduleFile(repoRoot: string, stem: string): string | null {
  for (const candidate of [`${stem}.rs`, join(stem, 'mod.rs')]) {
    if (isFile(resolve(repoRoot, candidate))) return candidate;
  }
  return null;
}

/**
 * True when a specifier that failed to resolve still points inside this crate: `crate::`, `self::`
 * and `super::` are in-crate by construction, so a miss is a dangling reference rather than a
 * dependency. A leading `::` is another crate, and a bare path may be one too, so both are left to
 * the caller's external classification.
 */
export function rustMissesInCrate(source: string): boolean {
  return /^(crate|self|super)(::|$)/.test(source);
}

/** The repo-relative file a Rust path names, or null when nothing in the tree matches. */
export function rustResolve(repoRoot: string, fromFile: string, source: string): string | null {
  if (source.startsWith('::')) return null; // another crate

  const segments = source.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  let base: string;
  let rest: string[];
  if (segments[0] === 'crate') {
    base = crateRoot(repoRoot, fromFile);
    rest = segments.slice(1);
  } else if (segments[0] === 'self') {
    base = moduleDir(fromFile);
    rest = segments.slice(1);
  } else if (segments[0] === 'super') {
    let dir = moduleDir(fromFile);
    let index = 0;
    while (segments[index] === 'super') {
      dir = dirname(dir);
      index += 1;
    }
    base = dir;
    rest = segments.slice(index);
  } else {
    // 2018 edition: a bare path may be an external crate; try it as a module first.
    base = crateRoot(repoRoot, fromFile);
    rest = segments;
  }

  // Longest prefix first: the file is the module, the last segments are items inside it.
  for (let cutoff = rest.length; cutoff > 0; cutoff -= 1) {
    const found = moduleFile(repoRoot, join(base, ...rest.slice(0, cutoff)));
    if (found) return found;
  }
  return null;
}
