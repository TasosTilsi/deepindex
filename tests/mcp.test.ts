import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { gitIndex } from '../src/git/indexer.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  searchKnowledge,
  getEntity,
  getBacklinks,
  getDecisions,
  getBugs,
  getPatterns,
} from '../src/mcp/tools.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type Database from 'better-sqlite3';

describe('mcp', () => {
  let db: Database.Database;
  let tmpDir: string;
  let FIXTURE: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-mcp-'));
    db = initDb(join(tmpDir, 'test.db'));
    FIXTURE = createGitFixture();
    gitIndex(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('createMcpServer registers 6 read-only tools (MCP-02)', () => {
    const server = createMcpServer(db);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining(['search_knowledge', 'get_entity', 'get_backlinks', 'get_decisions', 'get_bugs', 'get_patterns'])
    );
    expect(names.length).toBe(6);
  });

  it('search_knowledge returns typed entities via FTS5', () => {
    const r = searchKnowledge(db, { query: 'error' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].type).toBe('bug_fix');
  });

  it('get_entity by name returns entity with merged-store context (D-11)', () => {
    const r = getEntity(db, { entity_id: 'off-by-one-error-in-counter-loop' });
    expect(r.type).toBe('bug_fix');
    expect(r).toHaveProperty('symbols');
    expect(r).toHaveProperty('dataFlow');
  });

  it('get_entity by UUID works', () => {
    const byName = getEntity(db, { entity_id: 'off-by-one-error-in-counter-loop' });
    const byId = getEntity(db, { entity_id: byName.id });
    expect(byId.id).toBe(byName.id);
  });

  it('get_entity returns error for unknown id', () => {
    const r = getEntity(db, { entity_id: 'nonexistent' });
    expect(r.error).toBeTruthy();
  });

  it('get_backlinks traverses relationships', () => {
    const r = getBacklinks(db, { entity_id: 'off-by-one-error-in-counter-loop', hops: 1 });
    expect(r.related.length).toBeGreaterThan(0);
    expect(r.related[0].relationship).toBeTruthy();
  });

  it('get_decisions/get_bugs/get_patterns filter by type', () => {
    const decisions = getDecisions(db, {});
    const bugs = getBugs(db, {});
    const patterns = getPatterns(db, {});
    for (const d of decisions.results) expect(d.type).toBe('decision');
    for (const b of bugs.results) expect(b.type).toBe('bug_fix');
    for (const p of patterns.results) expect(p.type).toBe('pattern');
  });
});
