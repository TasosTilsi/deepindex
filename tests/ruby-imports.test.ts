import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Ruby (`require_relative`), issue #20.
 *
 * `require_relative 'helper'` is relative to the *file*, not to a load path, which makes it one of
 * the few import forms in Ruby that names a file in this repository. A bare `require 'json'` is a
 * gem or the standard library and stays external. The specifier is normalised to `./helper` at
 * extraction time, so a miss is then broken by the same rule every relative import uses.
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

describe('ruby imports', () => {
  it('resolves require_relative against the file, and leaves a gem require external', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-ruby-'));
    try {
      writeFiles(dir, {
        'lib/helper.rb': 'def help; 1; end\n',
        'lib/nested/deep.rb': 'DEEP = 1\n',
        'lib/app.rb':
          "require 'json'\nrequire_relative './helper'\nrequire_relative 'nested/deep'\nrequire_relative 'gone'\n",
      });
      const db = await build(dir);
      expect(rows(db, 'lib/app.rb')).toEqual([
        { source: './gone', resolved: 0, external: 0, target: null },
        { source: './helper', resolved: 1, external: 0, target: 'lib/helper.rb' },
        { source: './nested/deep', resolved: 1, external: 0, target: 'lib/nested/deep.rb' },
        { source: 'json', resolved: 1, external: 1, target: null },
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
