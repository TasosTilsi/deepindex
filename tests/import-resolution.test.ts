import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Relative specifier resolution (issue #16).
 *
 * TypeScript's NodeNext convention writes the EMITTED extension in the
 * specifier — `import { db } from './db.js'` — while the source on disk is
 * `db.ts`. This repository uses that convention throughout (see
 * tests/AGENTS.md), so a resolver that only appends extensions to the literal
 * specifier reports nearly every internal import as broken.
 *
 * Invariants locked here:
 *   1. `.js` / `.jsx` / `.mjs` / `.cjs` specifiers map onto their TS sources;
 *   2. an exact match on disk still wins over the mapping;
 *   3. a specifier that genuinely matches nothing stays broken.
 */
async function buildFixture(body: string): Promise<{ source: string; resolved: number }[]> {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-resolve-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), body);
  writeFileSync(join(dir, 'src', 'db.ts'), 'export const db = 1;\n');
  writeFileSync(join(dir, 'src', 'widget.tsx'), 'export const Widget = () => null;\n');
  writeFileSync(join(dir, 'src', 'helper.mts'), 'export const helper = 1;\n');
  writeFileSync(join(dir, 'src', 'legacy.cjs'), 'module.exports = {};\n');
  writeFileSync(join(dir, 'src', 'exact.ts'), 'export const exact = 1;\n');
  const db = initDb(join(dir, 'test.db'));
  await buildGraph(db, dir);
  const rows = db
    .prepare('SELECT source, resolved FROM imports ORDER BY source')
    .all() as { source: string; resolved: number }[];
  db.close();
  rmSync(dir, { recursive: true, force: true });
  return rows;
}

describe('relative import resolution', () => {
  it('maps a .js specifier onto the .ts source on disk (NodeNext)', async () => {
    const rows = await buildFixture("import { db } from './db.js';\nexport const x = db;\n");
    expect(rows).toEqual([{ source: './db.js', resolved: 1 }]);
  });

  it('maps .jsx onto .tsx and .mjs onto .mts', async () => {
    const rows = await buildFixture(
      "import { Widget } from './widget.jsx';\nimport { helper } from './helper.mjs';\nexport const y = [Widget, helper];\n"
    );
    expect(rows.every((r) => r.resolved === 1)).toBe(true);
  });

  it('prefers a real file over a mapped one', async () => {
    const rows = await buildFixture("import { exact } from './exact.ts';\nexport const z = exact;\n");
    expect(rows).toEqual([{ source: './exact.ts', resolved: 1 }]);
  });

  it('still reports a specifier that matches nothing', async () => {
    const rows = await buildFixture("import { nope } from './nope.js';\nexport const w = nope;\n");
    expect(rows).toEqual([{ source: './nope.js', resolved: 0 }]);
  });
});
