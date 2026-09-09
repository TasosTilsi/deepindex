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
  apiHealth,
  apiCommits,
  apiRelations,
  apiEntity,
  apiActivity,
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
    tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-dash-'));
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

  it('apiEntities returns entities + backlinks bounded to them', () => {
    const r = apiEntities(db);
    expect(r.entities.length).toBeGreaterThan(0);
    expect(r.backlinks.length).toBeGreaterThan(0);
    expect(r.entities[0]).toHaveProperty('type');
    expect(r.backlinks[0]).toHaveProperty('relationship');
    // Backlinks may only reference returned entities.
    const ids = new Set(r.entities.map((e) => e.id));
    for (const b of r.backlinks) {
      expect(ids.has(b.from_id)).toBe(true);
      expect(ids.has(b.to_id)).toBe(true);
    }
  });

  it('apiEntities respects limit and snippets content', () => {
    const r = apiEntities(db, 1);
    expect(r.entities.length).toBeLessThanOrEqual(1);
    if (r.entities[0]) expect(r.entities[0].content.length).toBeLessThanOrEqual(160);
    const ids = new Set(r.entities.map((e) => e.id));
    for (const b of r.backlinks) {
      expect(ids.has(b.from_id)).toBe(true);
      expect(ids.has(b.to_id)).toBe(true);
    }
  });

  it('apiDataflow returns tables, queries, services', () => {
    const r = apiDataflow(db);
    expect(r).toHaveProperty('tables');
    expect(r).toHaveProperty('queries');
    expect(r).toHaveProperty('services');
  });

  it('apiDataflow caps each category and drops edges to excluded queries', () => {
    const r = apiDataflow(db, 1);
    expect(r.tables.length).toBeLessThanOrEqual(1);
    expect(r.queries.length).toBeLessThanOrEqual(1);
    expect(r.services.length).toBeLessThanOrEqual(1);
    const qids = new Set(r.queries.map((q) => q.id));
    for (const t of r.tables) {
      for (const id of t.queryIds) expect(qids.has(id)).toBe(true);
    }
  });

  it('apiDataflow includes a service node for every included query file', () => {
    // The fixture has no SQL data — seed one query + table idempotently.
    const f = db.prepare('SELECT id FROM files LIMIT 1').get() as { id: number } | undefined;
    if (f) {
      db.prepare('INSERT OR IGNORE INTO sql_queries (id, query_text, file_id) VALUES (9999, ?, ?)').run('SELECT * FROM users', f.id);
      db.prepare('INSERT OR IGNORE INTO query_tables (query_id, table_name) VALUES (9999, ?)').run('users');
    }
    const r = apiDataflow(db, 50);
    expect(r.queries.length).toBeGreaterThan(0);
    const svcFiles = new Set(r.services.map((s) => s.file));
    for (const q of r.queries) expect(svcFiles.has(q.file)).toBe(true);
  });

  it('handleApi defaults the limit when the param is missing (regression: Number(null) is 0)', async () => {
    // The Data Flow view calls /api/dataflow with no limit — that used to
    // resolve to LIMIT 0 and render "No data-flow indexed".
    const f = db.prepare('SELECT id FROM files LIMIT 1').get() as { id: number } | undefined;
    if (f) {
      db.prepare('INSERT OR IGNORE INTO sql_queries (id, query_text, file_id) VALUES (9999, ?, ?)').run('SELECT * FROM users', f.id);
      db.prepare('INSERT OR IGNORE INTO query_tables (query_id, table_name) VALUES (9999, ?)').run('users');
    }
    const df = await handleApi(db, '/api/dataflow');
    expect(df.status).toBe(200);
    const dfBody = df.body as { tables: unknown[]; queries: unknown[]; services: unknown[] };
    expect(dfBody.tables.length).toBeGreaterThan(0);
    const ent = await handleApi(db, '/api/entities');
    expect(ent.status).toBe(200);
    const entBody = ent.body as { entities: unknown[] };
    expect(entBody.entities.length).toBeGreaterThan(0);
  });

  it('apiSearch returns typed entities', async () => {
    const r = await apiSearch(db, 'error');
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].type).toBe('bug_fix');
  });

  it('apiSymbols returns files + symbols', () => {
    const r = apiSymbols(db);
    expect(r.files.length).toBeGreaterThan(0);
    expect(r.symbols.length).toBeGreaterThan(0);
    expect(r.symbols[0]).toHaveProperty('name');
  });

  it('handleApi routes /api/overview and 404s unknown', async () => {
    const ov = await handleApi(db, '/api/overview');
    expect(ov.status).toBe(200);
    expect(ov.body).toHaveProperty('entities');
    const nf = await handleApi(db, '/api/nope');
    expect(nf.status).toBe(404);
  });

  it('handleApi clamps malformed limit params to defaults', async () => {
    // Regression: the dashboard used to build '?limit=500?project=x' (double
    // '?') — Number('500?project=x') is NaN, which better-sqlite3 rejects.
    const nan = await handleApi(db, '/api/entities?limit=500?project=x');
    expect(nan.status).toBe(200);
    const neg = await handleApi(db, '/api/symbols?limit=-1');
    expect(neg.status).toBe(200);
    const searchBad = await handleApi(db, '/api/search?q=error&limit=abc');
    expect(searchBad.status).toBe(200);
  });

  it('apiHealth returns score + dimensions + issues', () => {
    const h = apiHealth(db);
    expect(h).toHaveProperty('score');
    expect(h.dimensions).toHaveProperty('freshness');
    expect(h.dimensions).toHaveProperty('consistency');
    expect(Array.isArray(h.issues)).toBe(true);
  });

  it('apiCommits returns timeline with entity counts', () => {
    const r = apiCommits(db, 20);
    expect(r.commits.length).toBeGreaterThan(0);
    const c = r.commits[0];
    expect(c).toHaveProperty('sha');
    expect(c).toHaveProperty('message');
    expect(c).toHaveProperty('entityCount');
    expect(typeof c.entityCount).toBe('number');
    expect(Array.isArray(c.entities)).toBe(true);
    if (c.entityCount > 0) expect(c.entities.length).toBeGreaterThan(0);
  });

  it('apiActivity returns weekly series oldest-first', () => {
    const r = apiActivity(db, 12);
    expect(Array.isArray(r.activity)).toBe(true);
    for (let i = 1; i < r.activity.length; i++) {
      expect(r.activity[i - 1].week <= r.activity[i].week).toBe(true);
    }
    for (const w of r.activity) {
      expect(w).toHaveProperty('entities');
      expect(w).toHaveProperty('commits');
    }
  });

  it('apiRelations returns named endpoints', () => {
    const r = apiRelations(db, 100);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0]).toHaveProperty('from_name');
    expect(r[0]).toHaveProperty('to_name');
    expect(r[0]).toHaveProperty('relationship');
  });

  it('apiEntity returns detail with related + tags; handleApi 404s unknown', async () => {
    const ent = apiEntities(db, 1).entities[0];
    expect(ent).toBeDefined();
    const d = apiEntity(db, ent.id);
    expect(d).not.toBeNull();
    expect(d?.entity).toHaveProperty('name');
    expect(d?.entity).toHaveProperty('tags');
    expect(Array.isArray(d?.related)).toBe(true);
    const nf = await handleApi(db, `/api/entity?id=${encodeURIComponent('no-such-id')}`);
    expect(nf.status).toBe(404);
    const ok = await handleApi(db, `/api/entity?id=${encodeURIComponent(ent.id)}`);
    expect(ok.status).toBe(200);
  });

  it('handleApi routes /api/health, /api/commits, /api/relations', async () => {
    expect((await handleApi(db, '/api/health')).status).toBe(200);
    expect((await handleApi(db, '/api/commits?limit=2')).status).toBe(200);
    expect((await handleApi(db, '/api/relations?limit=5')).status).toBe(200);
  });

  // --- Phase 8 semantic surface contracts (SRSR-02/SRSR-03, DASH-02) ---

  it('handleApi /api/search?mode=semantic returns HybridHit-shaped rows', async () => {
    const r = await handleApi(db, '/api/search?q=error&mode=semantic', undefined, tmpDir);
    expect(r.status).toBe(200);
    const rows = r.body as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const key of ['kind', 'id', 'label', 'score', 'source']) {
      expect(rows[0]).toHaveProperty(key);
    }
  });

  it('handleApi /api/search without mode keeps the legacy SearchHit shape (byte-identical pin)', async () => {
    const r = await handleApi(db, '/api/search?q=error');
    expect(r.status).toBe(200);
    const rows = r.body as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const key of ['id', 'type', 'name', 'rank']) {
      expect(rows[0]).toHaveProperty(key);
    }
    expect(rows[0]).not.toHaveProperty('kind');
    expect(rows[0]).not.toHaveProperty('source');
  });

  it('handleApi /api/embed-status returns the EmbedStatus contract (read-only)', async () => {
    const r = await handleApi(db, '/api/embed-status', undefined, tmpDir);
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    for (const key of ['available', 'model', 'dim', 'coverage', 'staleCount', 'corpusCounts']) {
      expect(body).toHaveProperty(key);
    }
    expect(typeof body.available).toBe('boolean');
    expect(body.dim).toBe(384);
  });

  it('handleApi /api/search invalid mode behaves as omitted; malformed limits clamp to defaults', async () => {
    const badMode = await handleApi(db, '/api/search?q=error&mode=bogus');
    expect(badMode.status).toBe(200);
    const badRows = badMode.body as Array<Record<string, unknown>>;
    expect(badRows.length).toBeGreaterThan(0);
    expect(badRows[0]).not.toHaveProperty('kind'); // legacy shape — mode treated as absent
    const nan = await handleApi(db, '/api/search?q=error&limit=abc');
    expect(nan.status).toBe(200);
    expect((nan.body as unknown[]).length).toBeLessThanOrEqual(20);
    const neg = await handleApi(db, '/api/search?q=error&limit=-1');
    expect(neg.status).toBe(200);
    expect((neg.body as unknown[]).length).toBeLessThanOrEqual(20);
  });

  it('apiProjects lists registered projects', () => {
    const regPath = join(tmpDir, 'projects.json');
    registerProject({ name: 'p1', path: '/x/p1', dbPath: join(tmpDir, 'test.db') }, regPath);
    const r = apiProjects(regPath);
    expect(r.projects.length).toBeGreaterThan(0);
    expect(r.projects[0].name).toBe('p1');
  });
});
