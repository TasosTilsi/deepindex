import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { gitIndex } from '../src/git/indexer.js';
import { sessionStart } from '../src/hooks/session-start.js';
import { userPromptSubmit } from '../src/hooks/user-prompt-submit.js';
import { postToolUse } from '../src/hooks/post-tool-use.js';
import { sessionEnd } from '../src/hooks/session-end.js';
import { installClaudeSettings } from '../src/mcp/install.js';
import { createGitFixture } from './helpers/git-fixture.js';
import type Database from 'better-sqlite3';

describe('hooks', () => {
  let db: Database.Database;
  let tmpDir: string;
  let dbPath: string;
  let FIXTURE: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-hooks-'));
    dbPath = join(tmpDir, 'test.db');
    db = initDb(dbPath);
    FIXTURE = createGitFixture();
    gitIndex(db, FIXTURE);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('session-start syncs git (HOOK-01)', () => {
    const r = sessionStart(FIXTURE, dbPath);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('git sync');
  });

  it('session-start returns error for missing repo', () => {
    const r = sessionStart('/nonexistent/path', dbPath);
    expect(r.ok).toBe(false);
  });

  it('user-prompt-submit injects context (HOOK-02)', async () => {
    const r = await userPromptSubmit('counter loop', FIXTURE, dbPath);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('topFiles');
  });

  it('post-tool-use captures tool calls (HOOK-03)', () => {
    const logDir = join(tmpDir, 'log');
    const r = postToolUse('Read', 's1', logDir);
    expect(r.ok).toBe(true);
    expect(existsSync(join(logDir, 'tool-use.log'))).toBe(true);
  });

  it('session-end writes summary (HOOK-03)', () => {
    const logDir = join(tmpDir, 'log');
    const r = sessionEnd('s1', 'test summary', logDir);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(logDir, 'session-s1.md'), 'utf8')).toContain('test summary');
  });

  it('installClaudeSettings is additive (D-08)', () => {
    const proj = join(tmpDir, 'proj');
    const r = installClaudeSettings(proj);
    expect(r.mcpAdded).toBe(true);
    expect(r.hooksAdded).toBe(true);
    const settings = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(settings.mcpServers.deepindex).toBeTruthy();
    expect(settings.hooks.SessionStart).toBeTruthy();
    // Second install is a no-op (additive, no clobber).
    const r2 = installClaudeSettings(proj);
    expect(r2.mcpAdded).toBe(false);
    expect(r2.hooksAdded).toBe(false);
  });
});
