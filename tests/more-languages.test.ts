import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Go, Lua, Bash and Dart (issue #20).
 *
 * Each names a file differently, and the difference that matters is what a miss MEANS: a `source
 * ./x.sh` that is not there is broken (the path is explicit), a Lua `require 'mod.sub'` that is not
 * there is a system module and stays external, and a Go import inside this module that leads
 * nowhere is broken while a standard-library one is external.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function build(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-more-'));
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

describe('go imports', () => {
  const TREE = {
    'go.mod': 'module example.com/mod\n\ngo 1.22\n',
    'pkg/sub/a.go': 'package sub\n\nfunc Exported() int { return 1 }\nfunc privateOne() int { return 2 }\n',
    'pkg/sub/b.go': 'package sub\n',
    'cmd/main.go': 'package main\n\nimport (\n\t"fmt"\n\t"example.com/mod/pkg/sub"\n\t"example.com/mod/gone"\n)\n',
  };

  it('maps a module path to the package directory and picks its first file', async () => {
    const { db, dir } = await build(TREE);
    try {
      expect(rows(db, 'cmd/main.go')).toEqual([
        // Inside this module, and the directory is not there: dangling, not a dependency.
        { source: 'example.com/mod/gone', resolved: 0, external: 0, target: null },
        { source: 'example.com/mod/pkg/sub', resolved: 1, external: 0, target: 'pkg/sub/a.go' },
        { source: 'fmt', resolved: 1, external: 1, target: null },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exports what Go capitalises', async () => {
    const { db, dir } = await build(TREE);
    try {
      const symbols = db
        .prepare("SELECT name, exported FROM symbols ORDER BY name")
        .all() as Array<{ name: string; exported: number }>;
      // cmd/main.go in this fixture declares no function, and a package clause is not a symbol:
      // the two versions of this list that failed before were both wrong about what to expect.
      expect(symbols).toEqual([
        { name: 'Exported', exported: 1 },
        { name: 'privateOne', exported: 0 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lua imports', () => {
  it('turns a dotted module into a path, and leaves an unknown one external', async () => {
    const { db, dir } = await build({
      'mod/sub.lua': 'local M = {}\nfunction M.run() return 1 end\nreturn M\n',
      'main.lua': "local s = require('mod.sub')\nlocal j = require('json')\n",
    });
    try {
      expect(rows(db, 'main.lua')).toEqual([
        { source: 'json', resolved: 1, external: 1, target: null },
        { source: 'mod.sub', resolved: 1, external: 0, target: 'mod/sub.lua' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('lua imports nested in another call', () => {
  it('reads a require that is an argument of something else', async () => {
    // The branch returned for every `function_call` that was not a require, so a require nested in
    // another call — `setup(require('mod.sub'))` — was never seen.
    const { db, dir } = await build({
      'mod/sub.lua': 'local M = {}\nreturn M\n',
      'main.lua': "local s = setup(require('mod.sub'))\n",
    });
    try {
      expect(rows(db, 'main.lua')).toEqual([
        { source: 'mod.sub', resolved: 1, external: 0, target: 'mod/sub.lua' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bash imports', () => {
  it('resolves `source ./x.sh` and calls a missing one broken', async () => {
    const { db, dir } = await build({
      'lib/helper.sh': 'helper() { echo hi; }\n',
      'run.sh': 'source ./lib/helper.sh\n. ./gone.sh\n',
    });
    try {
      expect(rows(db, 'run.sh')).toEqual([
        // `.` is the same builtin spelled shorter.
        { source: './gone.sh', resolved: 0, external: 0, target: null },
        { source: './lib/helper.sh', resolved: 1, external: 0, target: 'lib/helper.sh' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('dart imports', () => {
  it('resolves a relative import and never extracts a package: one', async () => {
    const { db, dir } = await build({
      'lib/src/local.dart': 'class Local {}\nclass _Hidden {}\n',
      'lib/main.dart': "import 'src/local.dart';\nimport 'package:http/http.dart';\n",
    });
    try {
      expect(rows(db, 'lib/main.dart')).toEqual([
        { source: 'src/local.dart', resolved: 1, external: 0, target: 'lib/src/local.dart' },
      ]);
      const symbols = db
        .prepare("SELECT name, exported FROM symbols WHERE name LIKE '%idden%' OR name = 'Local' ORDER BY name")
        .all() as Array<{ name: string; exported: number }>;
      expect(symbols).toEqual([
        { name: 'Local', exported: 1 },
        { name: '_Hidden', exported: 0 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
