import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { gitIndex } from '../src/git/indexer.js';
import { buildGraph } from '../src/graph/build.js';
import {
  apiOverview,
  apiEntities,
  apiDataflow,
  apiSearch,
  apiSymbols,
  apiProjects,
  handleApi,
} from '../src/dashboard/api.js';
import { registerProject } from '../src/registry.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type Database from 'better-sqlite3';

const SAMPLE_FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('dashboard api', () => {
  let db: Database.Database;
  let tmpDir: string;
  let GIT_FIXTURE: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-dash-'));
    db = initDb(join(tmpDir, 'test.db'));
    GIT_FIXTURE = createGitFixture();
    gitIndex(db, GIT_FIXTURE);
    await buildGraph(db, SAMPLE_FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(GIT_FIXTURE, { recursive: true, force: true });
  });

  it('apiOverview returns counts + entity types', () => {
    const ov = apiOverview(db);
    expect(ov.entities).toBeGreaterThan(0);
    expect(ov.commits).toBeGreaterThan(0);
    expect(Array.isArray(ov.entityTypes)).toBe(true);
    expect(ov.entityTypes[0]).toHaveProperty('type');
    expect(ov.entityTypes[0]).toHaveProperty('c');
  });

  it('apiEntities returns entities + backlinks', () => {
    const r = apiEntities(db);
    expect(r.entities.length).toBeGreaterThan(0);
    expect(r.backlinks.length).toBeGreaterThan(0);
    expect(r.entities[0]).toHaveProperty('type');
    expect(r.backlinks[0]).toHaveProperty('relationship');
  });

  it('apiDataflow returns tables, queries, services', () => {
    const r = apiDataflow(db);
    expect(r).toHaveProperty('tables');
    expect(r).toHaveProperty('queries');
    expect(r).toHaveProperty('services');
  });

  it('apiSearch returns typed entities', () => {
    const r = apiSearch(db, 'error');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].type).toBe('bug_fix');
  });

  it('apiSymbols returns files + symbols', () => {
    const r = apiSymbols(db);
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(r.symbols[0]).toHaveProperty('name');
  });

  it('handleApi routes /api/overview and 404s unknown', () => {
    const ov = handleApi(db, '/api/overview');
    expect(ov.status).toBe(200);
    expect(ov.body).toHaveProperty('entities');
    const nf = handleApi(db, '/api/nope');
    expect(nf.status).toBe(404);
  });

  it('apiProjects lists registered projects', () => {
    const regPath = join(tmpDir, 'projects.json');
    registerProject({ name: 'p1', path: '/x/p1', dbPath: join(tmpDir, 'test.db') }, regPath);
    const r = apiProjects(regPath);
    expect(r.projects.length).toBeGreaterThan(0);
    expect(r.projects[0].name).toBe('p1');
  });
});
