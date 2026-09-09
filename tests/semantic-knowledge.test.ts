import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { initDb, closeDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import {
  buildCorpus,
  moduleCards,
  symbolDocs,
  markdownChunks,
} from '../src/semantic/knowledge.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('semantic knowledge corpus', () => {
  let db: Database.Database;
  const tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-ksrc-'));
  const dbPath = join(tmpDir, 'test.db');

  beforeAll(async () => {
    db = initDb(dbPath);
    await buildGraph(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // (a) KSRC-01: module card for a fixture file with an importer carries
  // exports + imported-by lines with the importer path.
  it('module card contains exports and imported-by lines with the importer path', () => {
    const cards = moduleCards(db);
    const cCard = cards.find((c) => c.id === 'module:src/c.ts');
    expect(cCard).toBeDefined();
    expect(cCard!.text).toContain('exports:');
    expect(cCard!.text).toContain('baz');
    expect(cCard!.text).toContain('ANSWER');
    expect(cCard!.text).toContain('imported-by:');
    expect(cCard!.text).toContain('src/b.ts');
    expect(cCard!.sourcePath).toBe('src/c.ts');
  });

  // (b) KSRC-02: md chunks split exactly at #{1,3} headings; IGNORED_DIRS and
  // dot-dirs excluded.
  it('markdown chunks split at heading boundaries and skip ignored/dot dirs', () => {
    const mdRoot = mkdtempSync(join(tmpdir(), 'deepindex-md-'));
    try {
      writeFileSync(
        join(mdRoot, 'guide.md'),
        '# Top\n\ntop body\n\n## Middle\n\nmiddle body\n\n### Deep\n\ndeep body\n'
      );
      mkdirSync(join(mdRoot, '.planning'), { recursive: true });
      writeFileSync(join(mdRoot, '.planning', 'x.md'), '# hidden\n');
      mkdirSync(join(mdRoot, '.dotdir'), { recursive: true });
      writeFileSync(join(mdRoot, '.dotdir', 'y.md'), '# dotdir\n');

      const chunks = markdownChunks(mdRoot);
      // 3 headings → 3 chunks (each starts at its heading line).
      expect(chunks.length).toBe(3);
      expect(chunks[0]!.text.startsWith('guide.md — # Top')).toBe(true);
      expect(chunks[1]!.text.startsWith('guide.md — ## Middle')).toBe(true);
      expect(chunks[2]!.text.startsWith('guide.md — ### Deep')).toBe(true);
      // Ignored / dot dirs excluded.
      expect(chunks.some((c) => c.sourcePath!.includes('.planning'))).toBe(false);
      expect(chunks.some((c) => c.sourcePath!.includes('.dotdir'))).toBe(false);
      // Heading split actually severed the bodies.
      expect(chunks[0]!.text).not.toContain('middle body');
    } finally {
      rmSync(mdRoot, { recursive: true, force: true });
    }
  });

  // (c) KSRC-03 graceful degradation: comment-thin fixture yields symbol docs
  // with empty docstring text and no throw.
  it('symbolDocs degrade gracefully for comment-thin symbols', () => {
    const docs = symbolDocs(db);
    const foo = docs.find((d) => d.id.startsWith('sym:') && d.label === 'foo');
    expect(foo).toBeDefined();
    // a.ts foo has no preceding comment → text ends without docstring lines.
    expect(foo!.text).toBe('foo (method)\nsrc/a.ts\n');
    expect(() => symbolDocs(db)).not.toThrow();
  });

  // (d) F-5 pin: no module card ever maps a .md path — markdown rows become
  // kind 'doc' via markdownChunks only.
  it('no moduleCards id maps a .md path', () => {
    const cards = moduleCards(db);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.id.startsWith('module:')).toBe(true);
      expect(card.id.toLowerCase().endsWith('.md')).toBe(false);
    }
  });

  it('buildCorpus concatenates all four kinds deterministically', () => {
    // The fixture has no git history in this temp db — seed one entity row so
    // entityDocs is exercised too.
    db.prepare(
      `INSERT INTO entities (id, type, name, content) VALUES ('e-seed', 'decision', 'seed entity', 'seeded for corpus test')`
    ).run();
    const corpus = buildCorpus(db, FIXTURE);
    const kinds = new Set(corpus.map((d) => d.kind));
    expect(kinds).toEqual(new Set(['entity', 'symbol', 'module', 'doc']));
    const again = buildCorpus(db, FIXTURE);
    expect(JSON.stringify(corpus.map((d) => d.id))).toBe(
      JSON.stringify(again.map((d) => d.id))
    );
  });
});