import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { searchEntities } from '../src/git/search.js';
import { embed } from '../src/semantic/embed.js';
import {
  FETCH_MODEL_COMMAND,
  hasCachedModel,
  fetchModel,
  getEmbedder,
  SemanticUnavailableError,
  MODEL_CONFIGS,
  type Embedder,
} from '../src/semantic/embedder.js';
import {
  loadSemanticConfig,
  loadHooksConfig,
} from '../src/semantic/config.js';

const FIXTURE = resolve(process.cwd(), 'fixtures/sample-repo');

function fakeEmbedder(model = 'fake'): Embedder {
  return {
    model,
    dim: 384,
    embed: async (texts) => texts.map((t) => Array.from({ length: 384 }, (_, i) => ((t.length + i) % 97) / 194 - 0.25)),
  };
}

describe('semantic config ([semantic]/[hooks] sections)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deepindex-cfg-'));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  // (a) .deepindex.toml fixtures parse per-section.
  it('parses [semantic] enabled/model and [hooks] session_budget_ms', () => {
    const repo = join(tmp, 'cfg-a');
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(repo, '.deepindex.toml'),
      '[health]\nrepair_below = 70\n\n[semantic]\nenabled = true\nmodel = bge\n\n[hooks]\nsession_budget_ms = 5000\n'
    );
    const sem = loadSemanticConfig(repo);
    expect(sem).toEqual({ enabled: true, model: 'bge' });
    expect(loadHooksConfig(repo)).toEqual({ sessionBudgetMs: 5000 });
  });

  it('missing file → defaults; garbage model value → minilm default', () => {
    const missing = join(tmp, 'cfg-missing');
    expect(loadSemanticConfig(missing)).toEqual({ enabled: false, model: 'minilm' });
    expect(loadHooksConfig(missing)).toEqual({ sessionBudgetMs: 10000 });
    const repo = join(tmp, 'cfg-garbage');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.deepindex.toml'), '[semantic]\nenabled = true\nmodel = gpt4-ultra\n');
    expect(loadSemanticConfig(repo)).toEqual({ enabled: true, model: 'minilm' });
  });
});

describe('embedder runtime (fetch seam + cache gate + resolver)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deepindex-emb-'));
  const emptyCache = join(tmp, 'empty-cache');
  let db: Database.Database;

  process.env.DEEPINDEX_MODEL_CACHE_DIR = emptyCache;
  db = initDb(join(tmp, 'test.db'));

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  // (b) empty cache dir → hasCachedModel false.
  it('hasCachedModel is false for an empty cache dir', () => {
    expect(hasCachedModel(MODEL_CONFIGS.minilm.name)).toBe(false);
  });

  // (c) EMBD-02/07: a loader that throws → SemanticUnavailableError naming
  // @huggingface/transformers; index/search unaffected (fixture db still
  // answers searchEntities afterwards).
  it('missing optional dependency degrades: search still works', async () => {
    await buildGraph(db, FIXTURE);
    const throwingLoader = async (): Promise<Embedder> => {
      throw new SemanticUnavailableError('@huggingface/transformers is not installed');
    };
    await expect(
      embed(db, { rootDir: FIXTURE, loader: throwingLoader })
    ).rejects.toThrow(/@huggingface\/transformers/);
    // Index/search unaffected by the semantic failure (RSK-4).
    expect(() => searchEntities(db, 'counter')).not.toThrow();
  });

  // (d) D-23 cache gate: no cached model + no embedder/loader → embed refuses
  // with the exact FETCH_MODEL_COMMAND string.
  it('embed without a cached model refuses naming the fetch command', async () => {
    await expect(embed(db, { rootDir: FIXTURE })).rejects.toThrow(
      FETCH_MODEL_COMMAND
    );
  });

  // (e) fetchModel download seam, CI-SAFE: injected factory writes the cache
  // marker — ZERO network; factory called exactly once with the right args.
  it('fetchModel runs the injected factory once and warms the cache marker', async () => {
    const freshCache = join(tmp, 'fresh-cache');
    process.env.DEEPINDEX_MODEL_CACHE_DIR = freshCache;
    let calls = 0;
    const factory = async (task: string, modelName: string): Promise<unknown> => {
      calls++;
      expect(task).toBe('feature-extraction');
      expect(modelName).toBe('Xenova/all-MiniLM-L6-v2');
      // Simulate what transformers.js persists on download: the marker dir.
      mkdirSync(join(freshCache, modelName), { recursive: true });
      return {};
    };
    await fetchModel('Xenova/all-MiniLM-L6-v2', { pipelineFactory: factory });
    expect(calls).toBe(1);
    expect(hasCachedModel('Xenova/all-MiniLM-L6-v2')).toBe(true);
    expect(existsSync(join(freshCache, 'Xenova/all-MiniLM-L6-v2'))).toBe(true);
  });

  // (f) getEmbedder resolution order: embedder beats loader beats cache;
  // empty cache + no overrides → FETCH_MODEL_COMMAND refusal.
  it('getEmbedder: embedder > loader > cache gate', async () => {
    process.env.DEEPINDEX_MODEL_CACHE_DIR = join(tmp, 'order-cache');
    const fake = fakeEmbedder();
    const loaderSpy = vi.fn(async () => fakeEmbedder('from-loader'));
    await expect(getEmbedder('m', { embedder: fake, loader: loaderSpy })).resolves.toBe(fake);
    expect(loaderSpy).not.toHaveBeenCalled();
    await expect(getEmbedder('m', { loader: loaderSpy })).resolves.toMatchObject({
      model: 'from-loader',
    });
    expect(loaderSpy).toHaveBeenCalledTimes(1);
    await expect(getEmbedder('m')).rejects.toThrow(FETCH_MODEL_COMMAND);
  });

  // (g) CONFIG-AWARE DEFAULT (D-24): [semantic] model=bge flows to the loader
  // spy without any call-site threading; removing the key falls back to
  // minilm — a silent minilm fallback for a bge user is impossible.
  it('embed() default model follows [semantic].model both ways', async () => {
    const repoBge = join(tmp, 'repo-bge');
    mkdirSync(repoBge, { recursive: true });
    writeFileSync(
      join(repoBge, '.deepindex.toml'),
      '[semantic]\nenabled = true\nmodel = bge\n'
    );
    const seen: string[] = [];
    await embed(db, {
      rootDir: repoBge,
      loader: async (m) => {
        seen.push(m);
        return fakeEmbedder(m);
      },
    });
    expect(seen).toEqual(['Xenova/bge-small-en-v1.5']);

    const repoPlain = join(tmp, 'repo-plain');
    mkdirSync(repoPlain, { recursive: true });
    writeFileSync(join(repoPlain, '.deepindex.toml'), '[semantic]\nenabled = true\n');
    const seenPlain: string[] = [];
    await embed(db, {
      rootDir: repoPlain,
      loader: async (m) => {
        seenPlain.push(m);
        return fakeEmbedder(m);
      },
    });
    expect(seenPlain).toEqual(['Xenova/all-MiniLM-L6-v2']);
  });
});