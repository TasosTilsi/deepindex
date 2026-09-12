import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { gitIndex } from '../src/git/indexer.js';
import { createMcpServer } from '../src/mcp/server.js';
import {
  searchKnowledge,
  semanticSearch,
  getEntity,
  getBacklinks,
  getDecisions,
  getBugs,
  getPatterns,
} from '../src/mcp/tools.js';
import type { HybridHit } from '../src/semantic/search-hybrid.js';
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

  it('createMcpServer registers 7 read-only tools (MCP-02 + SRSR-02 semantic_search)', () => {
    const server = createMcpServer(db);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(tools);
    expect(names).toEqual(
      expect.arrayContaining(['search_knowledge', 'semantic_search', 'get_entity', 'get_backlinks', 'get_decisions', 'get_bugs', 'get_patterns'])
    );
    expect(names.length).toBe(7);
  });

  it('semantic_search is registered (SRSR-02) and semanticSearch degrades to lexical-shaped hits', async () => {
    const server = createMcpServer(db);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(tools).toHaveProperty('semantic_search');
    // No vec tables / no [semantic] config in this fixture db → semantic mode
    // degrades to lexical fallback hits (source 'lexical', SRSR-03).
    const r = await semanticSearch(db, { query: 'error', mode: 'semantic' });
    expect(r.results.length).toBeGreaterThan(0);
    for (const key of ['kind', 'id', 'label', 'score', 'source']) {
      expect(r.results[0]).toHaveProperty(key);
    }
    const first = r.results[0] as HybridHit;
    expect(first.source).toBe('lexical');
    expect(first.kind).toBe('entity');
  });

  it('semanticSearch default mode returns HybridHit-shaped results', async () => {
    const r = await semanticSearch(db, { query: 'error' });
    expect(r.results.length).toBeGreaterThan(0);
    for (const key of ['kind', 'id', 'label', 'score', 'source']) {
      expect(r.results[0]).toHaveProperty(key);
    }
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

  // N-01: serverInfo used to hardcode '0.1.0' while --version read
  // package.json — an MCP client saw a stale version. The handshake must
  // report the real package version.
  it('initialize handshake reports the package.json version in serverInfo (N-01)', async () => {
    const PKG_VERSION = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8')
    ).version;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const server = createMcpServer(db);
    const client = new Client({ name: 'version-test', version: '0.0.1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    // connect() auto-runs the initialize handshake; getServerVersion() then
    // holds what the server reported.
    await client.connect(clientTransport);
    const info = client.getServerVersion();
    expect(info?.name).toBe('deepindex');
    expect(info?.version).toBe(PKG_VERSION);
    await client.close();
    await server.close();
  });

  // DI-06: MCP tool handlers must git-sync before querying. Long-lived MCP
  // sessions otherwise serve a stale knowledge graph — decisions/bugfixes
  // from commits made AFTER `mcp serve` started are invisible. The CLI
  // retrieve/search verbs already sync; the MCP seam must do the same.
  it('searchKnowledge sees commits made AFTER the initial index (DI-06)', () => {
    const repo = createGitFixture();
    const staleDir = mkdtempSync(join(tmpdir(), 'deepindex-mcp-stale-'));
    const staleDb = initDb(join(staleDir, 'stale.db'));
    gitIndex(staleDb, repo);
    // Post-index commit: a new bug_fix entity the DB has not seen.
    writeFileSync(
      join(repo, 'src', 'mod.ts'),
      'export function mod(a: number): number { return a % 2; }\n'
    );
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'fix: modulo truncation in mod helper'], {
      cwd: repo,
      stdio: 'ignore',
    });
    const prevCwd = process.cwd();
    process.chdir(repo); // handlers resolve the repo via process.cwd()
    try {
      const r = searchKnowledge(staleDb, { query: 'modulo truncation' });
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results.some((h) => h.content.includes('modulo truncation'))).toBe(true);
    } finally {
      process.chdir(prevCwd);
      staleDb.close();
      rmSync(staleDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
