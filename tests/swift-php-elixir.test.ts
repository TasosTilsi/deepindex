import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Swift, PHP and Elixir (issue #20) — the last three languages whose imports can name a file here.
 *
 * Their shapes were measured against the grammars, and each says something different about where a
 * file lives: a Swift import names a module (a directory under `Sources/`), a PHP require is a path
 * whose base is genuinely ambiguous, and an Elixir alias names a module by convention.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-spe-'));
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

describe('swift imports', () => {
  it('links a module to the first file of its target directory, and leaves the rest external', async () => {
    const { db, dir } = await build({
      'Sources/MyModule/A.swift': 'public struct A {}\n',
      'Sources/MyModule/B.swift': 'struct B {}\n',
      'Sources/App/main.swift': 'import MyModule\nimport Foundation\n',
    });
    try {
      expect(rows(db, 'Sources/App/main.swift')).toEqual([
        // Most Swift imports are the standard library or a package: nothing here to link.
        { source: 'Foundation', resolved: 1, external: 1, target: null },
        { source: 'MyModule', resolved: 1, external: 0, target: 'Sources/MyModule/A.swift' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('php includes', () => {
  it('resolves a required path, and never calls an unresolvable one broken', async () => {
    const { db, dir } = await build({
      'lib/helper.php': '<?php function help() { return 1; }\n',
      'inc/a.php': '<?php $a = 1;\n',
      'index.php':
        "<?php\nrequire 'lib/helper.php';\ninclude 'inc/a.php';\nrequire 'nowhere.php';\nrequire_once __DIR__ . '/b.php';\n",
    });
    try {
      expect(rows(db, 'index.php')).toEqual([
        { source: 'inc/a.php', resolved: 1, external: 0, target: 'inc/a.php' },
        { source: 'lib/helper.php', resolved: 1, external: 0, target: 'lib/helper.php' },
        // `include_path` may hold it: external, not broken. The `__DIR__ . '/b.php'` form is a
        // concatenation and produces no row at all.
        { source: 'nowhere.php', resolved: 1, external: 1, target: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('elixir imports', () => {
  it('maps a module to its conventional file, and leaves a dependency external', async () => {
    const { db, dir } = await build({
      'lib/my_app/accounts/user.ex': 'defmodule MyApp.Accounts.User do\nend\n',
      'lib/my_app/web.ex':
        'defmodule MyApp.Web do\n  alias MyApp.Accounts.User\n  import MyApp.Helpers\n  require Logger\nend\n',
    });
    try {
      expect(rows(db, 'lib/my_app/web.ex')).toEqual([
        // `MyApp.Accounts.User` → lib/my_app/accounts/user.ex
        { source: 'MyApp.Accounts.User', resolved: 1, external: 0, target: 'lib/my_app/accounts/user.ex' },
        // Not in this project: a dependency, or Logger.
        { source: 'MyApp.Helpers', resolved: 1, external: 1, target: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
