import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { gitIndex, gitSync, deriveCommitType } from '../src/git/indexer.js';
import { entityId } from '../src/git/extract.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type Database from 'better-sqlite3';

describe('git indexer', () => {
  let db: Database.Database;
  let tmpDir: string;
  let FIXTURE: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-git-'));
    db = initDb(join(tmpDir, 'test.db'));
    FIXTURE = createGitFixture();
    // Populate the files table so commit_files can link to it (D-16).
    await buildGraph(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('gitIndex walks and indexes all commits', () => {
    const r = gitIndex(db, FIXTURE);
    expect(r.commitsProcessed).toBeGreaterThanOrEqual(4);
    expect(r.entitiesInserted).toBeGreaterThanOrEqual(4);
    expect(r.relationshipsWritten).toBeGreaterThan(0);
  });

  it('populates commits with full metadata (D-16)', () => {
    const row = db.prepare('SELECT * FROM commits LIMIT 1').get() as {
      sha: string;
      message: string;
      author: string;
      author_date: string;
      commit_type: string;
    };
    expect(row.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(row.message).toBeTruthy();
    expect(row.author).toBeTruthy();
    expect(row.author_date).toBeTruthy();
    expect(row.commit_type).toBeTruthy();
  });

  it('writes commit_files join to files (D-16)', () => {
    const count = db.prepare('SELECT COUNT(*) c FROM commit_files').get() as { c: number };
    expect(count.c).toBeGreaterThan(0);
  });

  it('writes backlinks bidirectionally (D-11)', () => {
    const count = db.prepare('SELECT COUNT(*) c FROM backlinks').get() as { c: number };
    expect(count.c).toBeGreaterThan(0);
    // Every edge has an inverse.
    const inverse = db.prepare("SELECT COUNT(*) c FROM backlinks WHERE relationship LIKE 'inverse:%'").get() as {
      c: number;
    };
    expect(inverse.c).toBeGreaterThan(0);
  });

  it('gitSync processes 0 commits when up to date', () => {
    const r = gitSync(db, FIXTURE);
    expect(r.commitsProcessed).toBe(0);
  });

  it('gitSync auto-inits on a fresh DB (no cursor)', () => {
    const db2 = initDb(join(tmpDir, 'sync.db'));
    const r = gitSync(db2, FIXTURE);
    expect(r.commitsProcessed).toBeGreaterThanOrEqual(4);
    db2.close();
  });

  it('deriveCommitType parses conventional-commit prefixes', () => {
    expect(deriveCommitType('feat: add x')).toBe('feat');
    expect(deriveCommitType('fix: bug')).toBe('fix');
    expect(deriveCommitType('refactor(auth): change')).toBe('refactor');
    expect(deriveCommitType('random message')).toBe('other');
  });

  it('entities have valid types (D-15)', () => {
    const rows = db.prepare('SELECT DISTINCT type FROM entities').all() as { type: string }[];
    const valid = ['decision', 'bug_fix', 'pattern', 'tech_debt', 'concept', 'breaking_change', 'security_fix', 'workflow'];
    for (const r of rows) {
      expect(valid).toContain(r.type);
    }
  });

  it('entity ids are UUID5 (D-10)', () => {
    const row = db.prepare('SELECT id FROM entities LIMIT 1').get() as { id: string };
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
