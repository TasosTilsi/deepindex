import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { parseFile } from '../src/graph/parse.js';
import { getHealth } from '../src/health.js';
import type Database from 'better-sqlite3';

/**
 * Java imports and edges (#5 + #13).
 *
 * Two coupled defects. Java produced **no import rows at all** — the extractor
 * matched only the JS/TS `import_statement` node, while Java emits
 * `import_declaration` with a `scoped_identifier` child and no `source` field — so a
 * Java repo sat on the neutral fallback. And no Java symbol was ever marked
 * `exported`, so even a resolved import could not become an edge: the edge builder
 * needs an exported symbol on both sides.
 *
 * They land together on purpose. Import extraction alone makes Java scores *worse*
 * (one in-tree + one stdlib + one third-party import → consistency 1/3, score 60 → 53)
 * and resolution alone still yields zero edges.
 *
 * Invariants locked here:
 *   1. `import_declaration` is parsed, incl. `static` and wildcard forms;
 *   2. in-tree FQNs resolve to the exact file; a class-map miss is never "resolved";
 *   3. stdlib and third-party imports stay external (never claimed by the Java map);
 *   4. a Java file's public members are exported and its private ones are not;
 *   5. resolved Java imports produce edges.
 */
const MAIN = [
  'package com.example.app;',
  '',
  'import com.example.foo.Bar;',
  'import java.util.List;',
  'import org.apache.commons.lang3.StringUtils;',
  'import static com.example.foo.Bar.make;',
  'import com.example.dep.*;',
  '',
  'public class Main {',
  '  public void run() { new Bar().make(); }',
  '}',
  '',
].join('\n');

const BAR = [
  'package com.example.foo;',
  '',
  'public class Bar {',
  '  public void make() {}',
  '  private void secret() {}',
  '}',
  '',
].join('\n');

const UTIL = 'package com.example.dep;\n\npublic class Util {\n  public int use() { return 1; }\n}\n';

const BAR_PATH = 'src/main/java/com/example/foo/Bar.java';
const MAIN_PATH = 'src/main/java/com/example/app/Main.java';

function writeJavaFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

function writeJavaRepo(dir: string): void {
  writeJavaFiles(dir, {
    [BAR_PATH]: BAR,
    'src/main/java/com/example/dep/Util.java': UTIL,
    [MAIN_PATH]: MAIN,
  });
}

async function buildJavaRepo(): Promise<{ db: Database.Database; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-java-'));
  writeJavaRepo(dir);
  const db = initDb(join(dir, 'test.db'));
  await buildGraph(db, dir);
  return { db, dir };
}

function importRow(
  db: Database.Database,
  from: string,
  source: string
): { resolved: number; external: number; target: string | null } | undefined {
  const row = db
    .prepare(
      `SELECT i.resolved AS resolved, i.external AS external, t.path AS target
       FROM imports i
       JOIN files f ON f.id = i.file_id
       LEFT JOIN files t ON t.id = i.resolved_file_id
       WHERE f.path = ? AND i.source = ?`
    )
    .get(from, source) as { resolved: number; external: number; target: string | null } | undefined;
  return row;
}

describe('java import extraction', () => {
  it('parses import_declaration, including static and wildcard forms', async () => {
    const result = await parseFile('Main.java', MAIN, '.java');
    expect(result.imports.map((i) => i.source)).toEqual([
      'com.example.foo.Bar',
      'java.util.List',
      'org.apache.commons.lang3.StringUtils',
      'com.example.foo.Bar.make',
      'com.example.dep.*',
    ]);
    expect(result.imports.map((i) => i.isStatic)).toEqual([false, false, false, true, false]);
  });
});

describe('java import resolution', () => {
  it('resolves in-tree FQNs, keeps stdlib and third-party external', async () => {
    const { db, dir } = await buildJavaRepo();
    try {
      const inTree = importRow(db, MAIN_PATH, 'com.example.foo.Bar');
      expect(inTree).toMatchObject({ resolved: 1, external: 0, target: BAR_PATH });

      const stat = importRow(db, MAIN_PATH, 'com.example.foo.Bar.make');
      expect(stat).toMatchObject({ resolved: 1, external: 0, target: BAR_PATH });

      const wildcard = importRow(db, MAIN_PATH, 'com.example.dep.*');
      expect(wildcard).toMatchObject({ resolved: 1, external: 0 });

      // Stdlib and third-party stay external: `resolved = 1` means "not a broken import"
      // (#8) while `external = 1` is the explicit classification, and target stays null —
      // the Java map must never claim a class it does not have in-tree.
      expect(importRow(db, MAIN_PATH, 'java.util.List')).toMatchObject({
        resolved: 1,
        external: 1,
        target: null,
      });
      expect(importRow(db, MAIN_PATH, 'org.apache.commons.lang3.StringUtils')).toMatchObject({
        resolved: 1,
        external: 1,
        target: null,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports consistency over in-tree Java imports instead of the neutral fallback', async () => {
    const { db, dir } = await buildJavaRepo();
    try {
      const report = getHealth(db);
      // Three in-tree imports, all resolved; the stdlib and third-party ones are
      // external and therefore outside the question this dimension asks.
      expect(report.dimensions.consistency).toBeCloseTo(1, 5);
      expect(report.issues.filter((i) => i.type === 'broken_import')).toHaveLength(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('java class map inputs that were uncovered', () => {
  it('names a class in the default package by its file stem, and resolves an import of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-java-default-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'Rooted.java'), 'public class Rooted { public int x() { return 1; } }\n');
      writeFileSync(join(dir, 'src', 'User.java'), 'import Rooted;\npublic class User { Rooted r; }\n');
      const { initDb } = await import('../src/graph/db.js');
      const { buildGraph } = await import('../src/graph/build.js');
      const db = initDb(join(dir, '.db'));
      await buildGraph(db, dir);
      const row = db
        .prepare("SELECT resolved FROM imports WHERE source = 'Rooted'")
        .get() as { resolved: number } | undefined;
      expect(row?.resolved).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not export a private member, and exports a package-private class', async () => {
    const { db, dir } = await buildJavaRepo();
    try {
      const exported = (name: string) =>
        (
          db
            .prepare('SELECT exported FROM symbols WHERE name = ? ORDER BY id LIMIT 1')
            .get(name) as { exported: number } | undefined
        )?.exported;
      expect(exported('Util')).toBe(1);
      expect(exported('secret')).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores a commented-out package declaration when naming a class', async () => {
    const { javaFqnFor } = await import('../src/graph/java-resolve.js');
    expect(javaFqnFor('src/a/Thing.java', '// package com.wrong;\npackage com.right;\nclass Thing {}')).toBe(
      'com.right.Thing'
    );
    expect(javaFqnFor('src/a/Thing.java', '/*\npackage com.wrong;\n*/\npackage com.right;\nclass Thing {}')).toBe(
      'com.right.Thing'
    );
  });
});

describe('java exported semantics and edges', () => {
  it('exports public members, not private ones', async () => {
    const { db, dir } = await buildJavaRepo();
    try {
      const exported = (name: string) =>
        (
          db
            .prepare('SELECT exported FROM symbols WHERE name = ? ORDER BY id LIMIT 1')
            .get(name) as { exported: number } | undefined
        )?.exported;
      expect(exported('Bar')).toBe(1);
      expect(exported('make')).toBe(1);
      expect(exported('secret')).toBe(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('turns a resolved Java import into a graph edge', async () => {
    const { db, dir } = await buildJavaRepo();
    try {
      const edges = db
        .prepare(
          `SELECT COUNT(*) AS c FROM edges e
           JOIN symbols s ON s.id = e.from_symbol_id
           JOIN files f ON f.id = s.file_id
           WHERE f.path = ?`
        )
        .get(MAIN_PATH) as { c: number };
      expect(edges.c).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a Java import whose package is here but whose class is not', () => {
  const DANGLING_MAIN = 'src/main/java/com/example/app/Main.java';

  it('is broken, not external — the class was renamed or deleted in-tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-java-dangling-'));
    try {
      writeJavaFiles(dir, {
        'src/main/java/com/example/foo/Bar.java': 'package com.example.foo;\npublic class Bar {}\n',
        [DANGLING_MAIN]:
          'package com.example.app;\nimport com.example.foo.Gone;\nimport java.util.List;\npublic class Main { Gone g; List<String> l; }\n',
      });
      const db = initDb(join(dir, '.db'));
      await buildGraph(db, dir);

      // com.example.foo exists in this repository, so a miss inside it is a real dangling
      // reference — before this, every non-relative Java specifier was external and a renamed
      // class was invisible in a dimension worth 0.3.
      expect(importRow(db, DANGLING_MAIN, 'com.example.foo.Gone')).toMatchObject({
        resolved: 0,
        external: 0,
        target: null,
      });
      // A package we have never seen stays external.
      expect(importRow(db, DANGLING_MAIN, 'java.util.List')).toMatchObject({ resolved: 1, external: 1 });

      const report = getHealth(db);
      expect(report.issues.filter((i) => i.type === 'broken_import')).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('static wildcard resolution order', () => {
  it('resolves `import static com.a.Bar.*` to the type, not to the nested package', async () => {
    const { buildJavaClassIndex, javaResolve } = await import('../src/graph/java-resolve.js');
    // Both exist: a class com.a.Bar, and a package com.a.Bar (home of the nested class X).
    const index = buildJavaClassIndex([
      { fqn: 'com.a.Bar', relPath: 'src/com/a/Bar.java' },
      { fqn: 'com.a.Bar.X', relPath: 'src/com/a/Bar/X.java' },
    ]);
    // Static wildcards are type-scoped, so the type wins; a plain `import com.a.Bar.*;` is
    // package-scoped and still finds the package.
    expect(javaResolve(index, 'com.a.Bar.*', true)).toBe('src/com/a/Bar.java');
    expect(javaResolve(index, 'com.a.Bar.*', false)).toBe('src/com/a/Bar/X.java');
  });
});
