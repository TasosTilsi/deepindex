import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Kotlin and Scala, issue #20.
 *
 * Both spell imports the way Java does — a package declaration plus a dotted path — so they go
 * through the same in-tree map rather than getting a resolver each. The names differ (`import_header`
 * for Kotlin, `import_declaration` for Scala) and so does the wildcard: Scala writes `_` where Java
 * writes `*`.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-pkg-'));
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
       LEFT JOIN files t ON t.id = i.resolved_file_id WHERE f.path = ? ORDER BY i.source`
    )
    .all(file);
}

describe('kotlin imports', () => {
  it('resolves an in-tree package, keeps the standard library external, and calls a miss broken', async () => {
    const { db, dir } = await build({
      'src/main/kotlin/com/example/foo/Bar.kt': 'package com.example.foo\n\nclass Bar\n',
      'src/main/kotlin/com/example/foo/Thing.kt': 'package com.example.foo\n\nclass Thing\n',
      'src/main/kotlin/app/Main.kt':
        'package app\n\nimport com.example.foo.Bar\nimport kotlin.collections.List\nimport com.example.foo.Gone\nimport com.example.foo.*\n',
    });
    try {
      // In the order the query returns (by source), not the order I would have written them.
      expect(rows(db, 'src/main/kotlin/app/Main.kt')).toEqual([
        // A wildcard names the package; the file is the first of it in path order.
        { source: 'com.example.foo.*', resolved: 1, external: 0, target: 'src/main/kotlin/com/example/foo/Bar.kt' },
        { source: 'com.example.foo.Bar', resolved: 1, external: 0, target: 'src/main/kotlin/com/example/foo/Bar.kt' },
        // The package exists, the class does not: a dangling reference, as in Java.
        { source: 'com.example.foo.Gone', resolved: 0, external: 0, target: null },
        { source: 'kotlin.collections.List', resolved: 1, external: 1, target: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports what Kotlin does not mark private', async () => {
    const { db, dir } = await build({
      'src/main/kotlin/com/example/foo/Bar.kt':
        'package com.example.foo\n\nclass Bar {\n    fun shown() {}\n    private fun hidden() {}\n}\n',
    });
    try {
      const symbols = db
        .prepare("SELECT name, exported FROM symbols WHERE name IN ('shown', 'hidden') ORDER BY name")
        .all() as Array<{ name: string; exported: number }>;
      expect(symbols).toEqual([
        { name: 'hidden', exported: 0 },
        { name: 'shown', exported: 1 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scala imports', () => {
  it('reads a grouped import down to its package and rewrites `_` to a wildcard', async () => {
    const { db, dir } = await build({
      'src/main/scala/com/example/foo/Bar.scala': 'package com.example.foo\n\nclass Bar\n',
      'src/main/scala/app/Main.scala':
        'package app\n\nimport com.example.foo.{Bar, Baz}\nimport scala.collection.mutable\nimport com.example.foo._\n',
    });
    try {
      expect(rows(db, 'src/main/scala/app/Main.scala')).toEqual([
        // `{Bar, Baz}` names members; the package is what exists on disk.
        { source: 'com.example.foo', resolved: 1, external: 0, target: 'src/main/scala/com/example/foo/Bar.scala' },
        { source: 'com.example.foo.*', resolved: 1, external: 0, target: 'src/main/scala/com/example/foo/Bar.scala' },
        { source: 'scala.collection.mutable', resolved: 1, external: 1, target: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
