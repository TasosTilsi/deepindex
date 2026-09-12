import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
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
import type { Embedder } from '../src/semantic/embedder.js';
import type Database from 'better-sqlite3';

function fakeEmbedder(model = 'fake'): Embedder {
  return {
    model,
    dim: 384,
    embed: async (texts) =>
      texts.map((t) => Array.from({ length: 384 }, (_, i) => ((t.length + i) % 89) / 178 - 0.25)),
  };
}

describe('hooks', () => {
  let db: Database.Database;
  let tmpDir: string;
  let dbPath: string;
  let FIXTURE: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-hooks-'));
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

  it('session-start syncs git (HOOK-01)', async () => {
    const r = await sessionStart(FIXTURE, dbPath);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('git sync');
  });

  it('session-start returns error for missing repo', async () => {
    const r = await sessionStart('/nonexistent/path', dbPath);
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
    // DI-05b: the MCP entry lives in the project-shareable root .mcp.json;
    // settings.json keeps the hooks.
    const mcp = JSON.parse(readFileSync(join(proj, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.deepindex).toBeTruthy();
    const settings = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(settings.hooks.SessionStart).toBeTruthy();
    // Second install is a no-op (additive, no clobber).
    const r2 = installClaudeSettings(proj);
    expect(r2.mcpAdded).toBe(false);
    expect(r2.hooksAdded).toBe(false);
  });
});

describe('sessionStart auto-chain (HOOK-04, D-26c/D-29)', () => {
  let chainDbPath: string;
  let fixture: string;
  const tmpChain = mkdtempSync(join(tmpdir(), 'deepindex-hookchain-'));

  beforeAll(() => {
    chainDbPath = join(tmpChain, 'chain.db');
    fixture = createGitFixture();
    // REVIEW-FIX W1: the chain's embed step is gated on [semantic].enabled AND
    // a cached model — these tests prove the chain end-to-end, so the fixture
    // opts in and a model-cache marker satisfies the gate without any native
    // model (the injected loader never reaches getEmbedder's real path).
    writeFileSync(join(fixture, '.deepindex.toml'), '[semantic]\nenabled = true\n');
    const cacheDir = join(tmpChain, 'model-cache');
    mkdirSync(join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2'), { recursive: true });
    process.env.DEEPINDEX_MODEL_CACHE_DIR = cacheDir;
  });

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    rmSync(tmpChain, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  });

  // (a) Chain order git-sync → index → embed on a fresh session with an
  // injected loader (fake embedder, zero native code).
  it('chains git-sync, re-index and embed in order on a fresh session', async () => {
    const loaderModels: string[] = [];
    const r = await sessionStart(fixture, chainDbPath, {
      budgetMs: 60000,
      loader: async (m) => {
        loaderModels.push(m);
        return fakeEmbedder(m);
      },
    });
    expect(r.ok).toBe(true);
    const syncAt = r.message.indexOf('git sync');
    const indexAt = r.message.indexOf('indexed');
    const embedAt = r.message.indexOf('embedded');
    expect(syncAt).toBeGreaterThanOrEqual(0);
    expect(indexAt).toBeGreaterThan(syncAt);
    expect(embedAt).toBeGreaterThan(indexAt);
    expect(loaderModels.length).toBe(1);
    // All three stores updated by the single chain (HOOK-04 acceptance).
    const db = initDb(chainDbPath);
    try {
      const commits = db.prepare('SELECT COUNT(*) c FROM commits').get() as { c: number };
      const files = db.prepare('SELECT COUNT(*) c FROM files').get() as { c: number };
      const meta = db.prepare('SELECT COUNT(*) c FROM embeddings_meta').get() as { c: number };
      expect(commits.c).toBeGreaterThan(0);
      expect(files.c).toBeGreaterThan(0);
      expect(meta.c).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  // (b) HOOK-04 acceptance: unchanged second session NEVER loads the model —
  // the loader spy records zero calls.
  it('second unchanged session completes without loading the model', async () => {
    const loader = vi.fn(async (m: string) => fakeEmbedder(m));
    const r = await sessionStart(fixture, chainDbPath, {
      budgetMs: 60000,
      loader,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('embeddings up to date');
    expect(loader).toHaveBeenCalledTimes(0);
  });

  // (c) Budget expiry: budgetMs 0 skips the embed step but git sync + index
  // still apply, ok stays true (cursor/hash guards make deferral safe).
  it('budgetMs 0 defers the embed step while git sync and index still apply', async () => {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(fixture, 'src', 'mul.ts'), '// budget test mutation\n');
    const loader = vi.fn(async (m: string) => fakeEmbedder(m));
    const r = await sessionStart(fixture, chainDbPath, {
      budgetMs: 0,
      loader,
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('git sync');
    expect(r.message).toContain('indexed');
    expect(r.message).toContain('deferred');
    expect(loader).toHaveBeenCalledTimes(0);
  });

  // (d) RSK-4: an embedder/ONNX failure never fails the chain — ok stays
  // true, index results survive, message names the embed failure.
  it('loader failure leaves ok true and the index intact', async () => {
    const r = await sessionStart(fixture, chainDbPath, {
      budgetMs: 60000,
      loader: async () => {
        throw new Error('onnx boom');
      },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('git sync');
    expect(r.message).toContain('indexed');
    expect(r.message).toContain('embed failed: onnx boom');
  });
});

// REVIEW-FIX W1: sessionStart step 3 is GATED — default installs (semantic
// disabled or model uncached) pay no corpus scan and no refusal noise.
describe('hooks: auto-embed gate (REVIEW finding 1)', () => {
  const tmpDir2 = mkdtempSync(join(tmpdir(), 'deepindex-hooks-gate-'));
  const dbPath2 = join(tmpDir2, 'g.db');
  const FIXTURE2 = createGitFixture();

  afterAll(() => {
    rmSync(tmpDir2, { recursive: true, force: true });
    rmSync(FIXTURE2, { recursive: true, force: true });
  });

  it('semantic disabled: hook completes without embed work and without noise', async () => {
    const r = await sessionStart(FIXTURE2, join(tmpDir2, 'a.db'));
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('embed');
    expect(r.message).not.toContain('run deepindex embed');
  });

  it('semantic enabled + model uncached: no refusal noise, still ok', async () => {
    writeFileSync(join(FIXTURE2, '.deepindex.toml'), '[semantic]\nenabled = true\n');
    const loader = vi.fn();
    const r = await sessionStart(FIXTURE2, join(tmpDir2, 'b.db'), { loader: loader as unknown as (m: string) => Promise<Embedder> });
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('embed failed');
    expect(r.message).not.toContain('run deepindex embed');
    expect(loader).not.toHaveBeenCalled();
    rmSync(join(FIXTURE2, '.deepindex.toml'));
  });
});

// Step 4 (D-06/D-29): sessionStart auto-repairs deterministically when health
// drops below [health] repair_below — no LLM client, no watcher; budget-gated
// like the other steps. Repair stages are deterministic, so nothing is
// injected: a broken import (resolved=0) drops consistency → score < the
// default threshold of 80; a fixture with repair_below = 40 scores 60 → OK.
describe('hooks: sessionStart auto-repair (step 4, D-06/D-29)', () => {
  const tmpRepair = mkdtempSync(join(tmpdir(), 'deepindex-hookrepair-'));

  afterAll(() => {
    rmSync(tmpRepair, { recursive: true, force: true });
  });

  it('health below threshold triggers deterministic repair (no LLM)', async () => {
    const fixture = createGitFixture();
    try {
      // Broken import → 1/1 imports unresolved → consistency 0, score 40.
      appendFileSync(join(fixture, 'src', 'mul.ts'), 'import { nope } from "./missing.js";\n');
      const r = await sessionStart(fixture, join(tmpRepair, 'low.db'));
      expect(r.ok).toBe(true);
      expect(r.message).toContain('auto-repair: 3 stages run');
      expect(r.message).not.toContain('llm');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('healthy repo logs health OK and runs no repair', async () => {
    const fixture = createGitFixture();
    try {
      writeFileSync(join(fixture, '.deepindex.toml'), '[health]\nrepair_below = 40\n');
      const r = await sessionStart(fixture, join(tmpRepair, 'ok.db'));
      expect(r.ok).toBe(true);
      expect(r.message).toContain('health OK (score 60 >= threshold 40)');
      expect(r.message).not.toContain('auto-repair');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
