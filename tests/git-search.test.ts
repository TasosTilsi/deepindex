import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { gitIndex } from '../src/git/indexer.js';
import { searchEntities, getRelated, getRelatedRecursive } from '../src/git/search.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type Database from 'better-sqlite3';

describe('git search', () => {
  let db: Database.Database;
  let tmpDir: string;
  let FIXTURE: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-search-'));
    db = initDb(join(tmpDir, 'test.db'));
    FIXTURE = createGitFixture();
    gitIndex(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('searchEntities returns typed entities via FTS5 (FTS-02)', () => {
    const hits = searchEntities(db, 'error');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].type).toBe('bug_fix');
    expect(hits[0].name).toContain('off-by-one');
  });

  it('searchEntities returns related entities via backlinks', () => {
    const hits = searchEntities(db, 'error');
    expect(hits[0].related.length).toBeGreaterThan(0);
    expect(hits[0].related[0].relationship).toBeTruthy();
    expect(hits[0].related[0].context).toBeTruthy();
  });

  it('searchEntities returns empty for no match', () => {
    expect(searchEntities(db, 'zzzzzznomatch')).toEqual([]);
  });

  it('searchEntities returns empty for blank query', () => {
    expect(searchEntities(db, '')).toEqual([]);
  });

  it('getRelated returns 1-hop traversal with label + context (BKLN-02)', () => {
    const hits = searchEntities(db, 'error');
    const id = hits[0].id;
    const related = getRelated(db, id);
    expect(related.length).toBeGreaterThan(0);
    for (const r of related) {
      expect(r.relationship).toBeTruthy();
      expect(r.context).toBeTruthy();
    }
  });

  it('getRelatedRecursive traverses multi-hop with cycle guard', () => {
    const hits = searchEntities(db, 'error');
    const id = hits[0].id;
    const related = getRelatedRecursive(db, id, 2);
    expect(related.length).toBeGreaterThan(0);
  });
});
