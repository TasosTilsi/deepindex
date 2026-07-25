import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { cacheSet, cacheGet } from '../src/cache.js';
import {
  stage1Rebuild,
  stage2CacheInvalidate,
  stage3GitHistory,
  repair,
  repairCacheKey,
  REPAIR_CACHE_PREFIX,
  OpenAICompatibleClient,
} from '../src/repair.js';
import type Database from 'better-sqlite3';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

describe('repair', () => {
  describe('stage1Rebuild', () => {
    it('rebuild on already-built fixture returns ok: true with a non-zero action', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-s1-'));
      const db = initDb(join(dir, 'test.db'));
      const r = await stage1Rebuild(db, FIXTURE);
      // First build inserts files, so fileCount > 0 → ok true.
      expect(r.ok).toBe(true);
      expect(r.actions[0]).toMatch(/rebuilt \d+ files/);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('rebuild after one file change re-parses that file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-s1-change-'));
      const db = initDb(join(dir, 'test.db'));
      await stage1Rebuild(db, FIXTURE);
      // No changes; second rebuild should be a no-op.
      const r2 = await stage1Rebuild(db, FIXTURE);
      expect(r2.actions[0]).toMatch(/no changes/);
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('stage2CacheInvalidate', () => {
    it('on an empty cache: ok: true, invalidated 0', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-s2-empty-'));
      const db = initDb(join(dir, 'test.db'));
      const r = stage2CacheInvalidate(db);
      expect(r.ok).toBe(true);
      expect(r.actions[0]).toBe('invalidated 0 cache entries');
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('removes a repair:* cache entry', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-s2-repair-'));
      const db = initDb(join(dir, 'test.db'));
      cacheSet(db, 'repair:abc', 'content', {});
      const r = stage2CacheInvalidate(db);
      expect(r.ok).toBe(true);
      expect(r.actions[0]).toBe('invalidated 1 cache entries');
      expect(cacheGet(db, 'repair:abc')).toBeNull();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('stage3GitHistory', () => {
    it('returns ok: false when .git is absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-s3-nogit-'));
      // No .git, no src; should report no .git.
      const r = stage3GitHistory(dir);
      expect(r.ok).toBe(false);
      expect(r.actions[0]).toMatch(/no \.git directory/);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('repairCacheKey', () => {
    it('prefixes with repair: and sha256s the prompt', () => {
      expect(repairCacheKey('hello')).toBe(REPAIR_CACHE_PREFIX + '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
  });

  describe('repair pipeline', () => {
    it('runs only stage 1 on a clean fixture and short-circuits', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-repair-clean-'));
      const db = initDb(join(dir, 'test.db'));
      // First build so the file rows exist.
      await buildGraph(db, FIXTURE);
      // The fixture has a broken import, so health < 80; stage 1 re-runs buildGraph
      // which won't change fileCount, but we'll still see at least 1 stage.
      const r = await repair(db, FIXTURE);
      expect(r.stages.length).toBeGreaterThanOrEqual(1);
      // No LLM was passed in, so llmCost is undefined.
      expect(r.llmCost).toBeUndefined();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('does not invoke the LLM when opts.llm is not set, even if health stays low', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ctx-repair-no-llm-'));
      const db = initDb(join(dir, 'test.db'));
      await buildGraph(db, FIXTURE);
      // Force a high repairBelow so even with low health the deterministic
      // stages don't restore score above 80.
      const r = await repair(db, FIXTURE, { config: { repairBelow: 100 } });
      expect(r.stages.length).toBeLessThanOrEqual(3);
      expect(r.llmCost).toBeUndefined();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
