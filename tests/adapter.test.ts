import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { gitIndex } from '../src/git/indexer.js';
import { adaptClaudeCode } from '../src/adapter-claude-code.js';
import { createGitFixture } from './helpers/git-fixture.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('adapter', () => {
  let dir: string;
  let dbPath: string;
  let GIT_FIXTURE: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'deepindex-adapter-'));
    dbPath = join(dir, 'test.db');
    const db = initDb(dbPath);
    await buildGraph(db, FIXTURE);
    db.close();
    GIT_FIXTURE = createGitFixture();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(GIT_FIXTURE, { recursive: true, force: true });
  });

  it('returns an AdapterResult with non-empty topFiles for "auth"', async () => {
    const r = await adaptClaudeCode('auth', FIXTURE, { dbPath, topK: 5 });
    expect(r.task).toBe('auth');
    expect(Array.isArray(r.topFiles)).toBe(true);
    expect(r.topFiles.length).toBeGreaterThan(0);
    expect(r.topFiles[0]).toHaveProperty('path');
    expect(r.topFiles[0]).toHaveProperty('score');
    expect(Array.isArray(r.topFiles[0].symbols)).toBe(true);
    expect(typeof r.topFiles[0].summary).toBe('string');
    expect(r.health).toHaveProperty('score');
    expect(r.health).toHaveProperty('dimensions');
    expect(Array.isArray(r.neighborhood)).toBe(true);
    expect(Array.isArray(r.entities)).toBe(true);
  });

  it('returns git-history entities in merged context (SC5)', async () => {
    const gitDb = join(dir, 'git.db');
    const db = initDb(gitDb);
    gitIndex(db, GIT_FIXTURE);
    db.close();
    const r = await adaptClaudeCode('counter loop', GIT_FIXTURE, { dbPath: gitDb });
    expect(r.entities.length).toBeGreaterThan(0);
    expect(r.entities[0]).toHaveProperty('type');
    expect(r.entities[0]).toHaveProperty('name');
  });

  it('defaults topK to 10 when omitted', async () => {
    const r = await adaptClaudeCode('with-comments', FIXTURE, { dbPath });
    expect(r.topFiles.length).toBeLessThanOrEqual(10);
  });

  it.skipIf(!existsSync(resolve(process.cwd(), '.deepindex.db')))(
    'uses .deepindex.db as the default dbPath when present',
    async () => {
      // No topK: confirm defaults flow through; no throw on call.
      const r = await adaptClaudeCode('auth', FIXTURE);
      expect(r.task).toBe('auth');
      expect(Array.isArray(r.topFiles)).toBe(true);
    }
  );

  it('rejects when dbPath points to a non-existent file', async () => {
    await expect(
      adaptClaudeCode('auth', FIXTURE, { dbPath: '/nonexistent/path/test.db' })
    ).rejects.toThrow();
  });
});
