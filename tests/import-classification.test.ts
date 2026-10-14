import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { getHealth } from '../src/health.js';
import type Database from 'better-sqlite3';

/**
 * Import classification (issue #8).
 *
 * A specifier that cannot have a target inside the repository — a `node:`
 * builtin, a bare package id, a workspace alias — is EXTERNAL. It is not a
 * broken import. Only a relative specifier with no file on disk is broken.
 *
 * Invariants locked here:
 *   1. externals never appear as broken imports;
 *   2. only in-repo imports count in the consistency denominator;
 *   3. the classification is explicit in the data model (`imports.external`),
 *      not inferred from a null `resolved_file_id`;
 *   4. an external specifier never claims an in-repo target.
 */
const EXTERNAL_SOURCES = ['@scope/thing', 'node:fs', 'node:path', 'vitest'];

function writeFixture(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'consumer.ts'),
    [
      "import { readFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "import { describe } from 'vitest';",
      "import { thing } from '@scope/thing';",
      "import { sibling } from './sibling';",
      'export function consume() {',
      '  return [readFileSync, join, describe, thing, sibling];',
      '}',
      '',
    ].join('\n')
  );
  writeFileSync(join(dir, 'src', 'sibling.ts'), 'export function sibling() { return 1; }\n');
  writeFileSync(
    join(dir, 'src', 'broken.ts'),
    "import { gone } from './gone';\nexport function use() { return gone; }\n"
  );
}

async function buildFixture(): Promise<{ db: Database.Database; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-import-classification-'));
  writeFixture(dir);
  const db = initDb(join(dir, 'test.db'));
  await buildGraph(db, dir);
  return { db, dir };
}

function cleanup(db: Database.Database, dir: string): void {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

describe('import classification', () => {
  it('reports only the relative miss as broken', async () => {
    const { db, dir } = await buildFixture();
    try {
      const broken = (
        db.prepare('SELECT source FROM imports WHERE resolved = 0 ORDER BY source').all() as {
          source: string;
        }[]
      ).map((r) => r.source);
      expect(broken).toEqual(['./gone']);
    } finally {
      cleanup(db, dir);
    }
  });

  it('counts only in-repo imports in the consistency denominator', async () => {
    const { db, dir } = await buildFixture();
    try {
      const report = getHealth(db);
      // In-repo: ./sibling (resolved) and ./gone (broken) -> 1 - 1/2 = 0.5.
      // The four externals are not part of the question this dimension asks.
      expect(report.dimensions.consistency).toBeCloseTo(0.5, 5);
      expect(report.issues.filter((i) => i.type === 'broken_import')).toHaveLength(1);
    } finally {
      cleanup(db, dir);
    }
  });

  it('marks external specifiers explicitly in the data model', async () => {
    const { db, dir } = await buildFixture();
    try {
      const externals = (
        db.prepare('SELECT source FROM imports WHERE external = 1 ORDER BY source').all() as {
          source: string;
        }[]
      ).map((r) => r.source);
      expect(externals).toEqual(EXTERNAL_SOURCES);
    } finally {
      cleanup(db, dir);
    }
  });

  it('never gives an external specifier an in-repo target', async () => {
    const { db, dir } = await buildFixture();
    try {
      const row = db
        .prepare(
          'SELECT COUNT(*) AS c FROM imports WHERE external = 1 AND resolved_file_id IS NOT NULL'
        )
        .get() as { c: number };
      expect(row.c).toBe(0);
    } finally {
      cleanup(db, dir);
    }
  });
});
