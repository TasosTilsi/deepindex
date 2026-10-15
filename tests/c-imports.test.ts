import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * C, C++ and Objective-C (`#include "..."`), issue #20.
 *
 * A quoted include names a file relative to the including file, then wherever the build's `-I`
 * flags point. Only the first is knowable here, so a quoted include that is not found **stays
 * external rather than being called broken**: reporting it broken would fill the health report
 * with false positives for every header that lives behind an include directory. Angle-bracket
 * includes are system headers by definition and produce no row.
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function build(dir: string) {
  const db = initDb(join(dir, '.db'));
  await buildGraph(db, dir);
  return db;
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

describe('c family includes', () => {
  it('resolves a quoted include next to the file, and never calls an unresolved one broken', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-c-'));
    try {
      writeFiles(dir, {
        'src/local.h': '#pragma once\n',
        'src/sub/deep.h': '#pragma once\n',
        'include/third_party.h': '#pragma once\n',
        'src/main.c': [
          '#include <stdio.h>',
          '#include "local.h"',
          '#include "sub/deep.h"',
          '#include "third_party.h"',
          '#include "nowhere.h"',
          '',
        ].join('\n'),
      });
      const db = await build(dir);
      expect(rows(db, 'src/main.c')).toEqual([
        { source: 'local.h', resolved: 1, external: 0, target: 'src/local.h' },
        // Not found anywhere we can see: external, not broken — `-I` may point at it.
        { source: 'nowhere.h', resolved: 1, external: 1, target: null },
        { source: 'sub/deep.h', resolved: 1, external: 0, target: 'src/sub/deep.h' },
        // Behind an include directory: knowable from the tree, worth linking.
        { source: 'third_party.h', resolved: 1, external: 0, target: 'include/third_party.h' },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('c symbol visibility', () => {
  it('exports a function unless it is static, which is file-local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-c-static-'));
    try {
      writeFiles(dir, {
        'src/api.c': 'int published(void) { return 1; }\nstatic int hidden(void) { return 2; }\n',
      });
      const db = await build(dir);
      const symbols = db
        .prepare('SELECT name, exported FROM symbols ORDER BY name')
        .all() as Array<{ name: string; exported: number }>;
      expect(symbols).toEqual([
        { name: 'hidden', exported: 0 },
        { name: 'published', exported: 1 },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
