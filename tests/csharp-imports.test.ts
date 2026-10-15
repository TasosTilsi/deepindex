import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * C# (`using`), issue #20 — the last language in the config whose imports can name a file here.
 *
 * A `using` names a NAMESPACE, so C# goes through the same in-tree map as Java, Kotlin and Scala.
 * Its package declaration is spelled `namespace` rather than `package`, which is the only thing the
 * map had to learn.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-cs-'));
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

describe('c# using directives', () => {
  it('resolves an in-tree namespace, keeps the framework external, and calls a miss broken', async () => {
    const { db, dir } = await build({
      'src/Data/Repo.cs': 'namespace App.Data;\n\npublic class Repo {}\n',
      'src/Core/Service.cs':
        'namespace App.Core;\n\nusing App.Data;\nusing System.Text;\nusing App.Data.Gone;\n',
    });
    try {
      expect(rows(db, 'src/Core/Service.cs')).toEqual([
        // The namespace is here, the type is not: a dangling reference. (`App.Data` is a
        // namespace this tree declares, so the prefix is one we KNOW — the earlier version of this
        // test used a bare `App.Gone`, which only looked broken because the resolver was matching
        // any shared first segment, and that heuristic broke every third-party import.)
        { source: 'App.Data.Gone', resolved: 0, external: 0, target: null },
        { source: 'App.Data', resolved: 1, external: 0, target: 'src/Data/Repo.cs' },
        { source: 'System.Text', resolved: 1, external: 1, target: null },
      ].sort((a, b) => (a.source < b.source ? -1 : 1)));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
