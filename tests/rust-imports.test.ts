import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Rust (`use` and `mod`), issue #20.
 *
 * Two things make Rust different from the languages already covered:
 *
 * 1. **A path names an item, not a file.** `use self::local::Thing;` names the type `Thing` inside
 *    the module `local`, so the file to link is the longest *prefix* of the path that is a module
 *    (`src/local.rs`), not the whole path.
 * 2. **Its visibility keyword marks the exported side.** Java's `private` marks what is not
 *    importable; Rust's `pub` marks what is. Treating "no modifier" as exported — right for Java,
 *    Python and the rest — is exactly backwards here, so the config needs its own rule.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function buildRustRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-rust-'));
  writeFiles(dir, files);
  const db = initDb(join(dir, '.db'));
  await buildGraph(db, dir);
  return { db, dir };
}

function rows(db: ReturnType<typeof initDb>, file: string) {
  return db
    .prepare(
      `SELECT i.source AS source, i.resolved AS resolved, i.external AS external, t.path AS target
       FROM imports i JOIN files f ON f.id = i.file_id
       LEFT JOIN files t ON t.id = i.resolved_file_id
       WHERE f.path = ? ORDER BY i.source`
    )
    .all(file) as Array<{ source: string; resolved: number; external: number; target: string | null }>;
}

describe('rust imports', () => {
  const TREE = {
    'src/helpers.rs': 'pub fn help() -> i32 { 1 }\nfn secret() -> i32 { 2 }\n',
    'src/a/mod.rs': '',
    'src/a/b.rs': 'pub struct B;\n',
    'src/main.rs': [
      'use crate::a::b::B;',
      'use crate::helpers;',
      'use ::serde::Serialize;',
      'use crate::gone::Missing;',
      'pub fn exported() -> i32 { 1 }',
      'fn private_one() -> i32 { 2 }',
      'mod helpers;',
      '',
    ].join('\n'),
  };

  it('links the longest module prefix of the path, not the whole path', async () => {
    const { db, dir } = await buildRustRepo(TREE);
    try {
      // `crate::a::b::B` names a struct inside the module a::b, so the file is a/b.rs.
      expect(rows(db, 'src/main.rs')).toEqual([
        // A leading `::` is an absolute path into another crate: nothing here to link.
        { source: '::serde::Serialize', resolved: 1, external: 1, target: null },
        { source: 'crate::a::b::B', resolved: 1, external: 0, target: 'src/a/b.rs' },
        { source: 'crate::gone::Missing', resolved: 0, external: 0, target: null },
        { source: 'crate::helpers', resolved: 1, external: 0, target: 'src/helpers.rs' },
        { source: 'self::helpers', resolved: 1, external: 0, target: 'src/helpers.rs' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats `::crate` as external and an in-crate miss as broken', async () => {
    const { db, dir } = await buildRustRepo(TREE);
    try {
      // Another crate is external, the same way `java.util.List` is for Java...
      const external = db
        .prepare("SELECT COUNT(*) AS n FROM imports WHERE source = '::serde::Serialize' AND external = 1")
        .get() as { n: number };
      expect(external.n).toBe(1);
      // ...while a path that starts at this crate root and leads nowhere is a real dangling
      // reference, and it is the only broken row in the tree.
      const broken = db
        .prepare("SELECT COUNT(*) AS n FROM imports WHERE source = 'crate::gone::Missing'")
        .get() as { n: number };
      expect(broken.n).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports on `pub`, not on the absence of a modifier', async () => {
    const { db, dir } = await buildRustRepo(TREE);
    try {
      const symbols = db
        .prepare('SELECT name, exported FROM symbols ORDER BY name')
        .all() as Array<{ name: string; exported: number }>;
      expect(symbols).toEqual([
        { name: 'B', exported: 1 },
        { name: 'exported', exported: 1 },
        { name: 'help', exported: 1 },
        { name: 'private_one', exported: 0 },
        { name: 'secret', exported: 0 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rust module bases that the first version got wrong', () => {
  it('resolves `self::` from a plain module file, whose children live in <name>/', async () => {
    // Rust 2018: `src/a.rs` owns `src/a/`. Using the file's own directory put `self::b` in `src/`,
    // so this resolved to nothing (and was then locked as broken) although src/a/b.rs existed.
    const { db, dir } = await buildRustRepo({
      'src/main.rs': 'mod a;\n',
      'src/a.rs': 'use self::b::Thing;\n',
      'src/a/b.rs': 'pub struct Thing;\n',
    });
    try {
      expect(rows(db, 'src/a.rs')).toEqual([
        { source: 'self::b::Thing', resolved: 1, external: 0, target: 'src/a/b.rs' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves `crate::` from the root beside Cargo.toml, not a hardcoded src/', async () => {
    // A Cargo workspace keeps members under `crates/<name>/src`, and `crate::` there means that
    // member's root. The first version hardcoded `src` and resolved nothing.
    const { db, dir } = await buildRustRepo({
      'crates/foo/Cargo.toml': '[package]\nname = "foo"\n',
      'crates/foo/src/main.rs': 'use crate::util::Thing;\n',
      'crates/foo/src/util.rs': 'pub struct Thing;\n',
    });
    try {
      expect(rows(db, 'crates/foo/src/main.rs')).toEqual([
        { source: 'crate::util::Thing', resolved: 1, external: 0, target: 'crates/foo/src/util.rs' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the imports inside an inline `mod tests { … }`', async () => {
    // The canonical Rust test module. An early `return` on the inline case meant it produced no
    // rows at all — the descent happens at the end of collectImports, so returning there swallowed
    // everything inside the block.
    const { db, dir } = await buildRustRepo({
      'src/lib.rs': 'pub mod x;\n\n#[cfg(test)]\nmod tests {\n    use crate::x::Thing;\n}\n',
      'src/x.rs': 'pub struct Thing;\n',
    });
    try {
      expect(rows(db, 'src/lib.rs')).toContainEqual({
        source: 'crate::x::Thing',
        resolved: 1,
        external: 0,
        target: 'src/x.rs',
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
