import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
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
// REVIEW-FIX W4: pipeline construction memoized per model — two loadRealEmbedder
// calls share one pipeline construction (long-lived MCP/serve processes pay the
// ONNX load once, not per query).
describe('review-fix W4: embedder memoization', () => {
  const tmpDir3 = mkdtempSync(join(tmpdir(), 'deepindex-embedder-memo-'));
  let pipelineCalls = 0;

  beforeAll(() => {
    const cacheDir = join(tmpDir3, 'model-cache');
    mkdirSync(join(cacheDir, 'Xenova', 'all-MiniLM-L6-v2'), { recursive: true });
    process.env.DEEPINDEX_MODEL_CACHE_DIR = cacheDir;
    vi.doMock('@huggingface/transformers', () => ({
      pipeline: async () => {
        pipelineCalls++;
        return async (texts: string[]) => ({
          tolist: () => texts.map(() => new Array(384).fill(0.5)),
        });
      },
      env: { cacheDir: cacheDir, allowLocalModels: true },
    }));
  });

  afterAll(() => {
    rmSync(tmpDir3, { recursive: true, force: true });
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    vi.resetModules();
  });

  it('two loadRealEmbedder calls construct the pipeline once', async () => {
    vi.resetModules(); // force the dynamic import below through vi.doMock
    const { loadRealEmbedder } = await import('../src/semantic/embedder.js');
    const a = await loadRealEmbedder(MODEL_CONFIGS.minilm.name);
    const b = await loadRealEmbedder(MODEL_CONFIGS.minilm.name);
    expect(pipelineCalls).toBe(1);
    expect(a.embed).toBe(b.embed);
  });
});

// DI-01: the vector layer must be reachable for pinned-npx consumers —
// @huggingface/transformers ships as an optionalDependency (default-installed;
// --omit=optional escape) instead of a missing manual install step.
describe('packaging (DI-01)', () => {
  it('declares @huggingface/transformers in optionalDependencies with an exact pin', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const pin = pkg.optionalDependencies?.['@huggingface/transformers'];
    expect(typeof pin).toBe('string');
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/); // exact version, no range
  });

  it('pnpm-workspace.yaml allows builds for the transformers native deps', () => {
    const ws = yamlLoad(readFileSync(join(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')) as {
      onlyBuiltDependencies?: string[];
    };
    expect(ws.onlyBuiltDependencies ?? []).toEqual(
      expect.arrayContaining(['onnxruntime-node', 'sharp'])
    );
  });

  it('package.json pnpm.onlyBuiltDependencies also lists the native deps (pnpm<10 reads package.json)', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.pnpm?.onlyBuiltDependencies ?? []).toEqual(
      expect.arrayContaining(['onnxruntime-node', 'sharp'])
    );
  });
});

// DI-03: fetchModel must pin the HuggingFace revision (two machines fetching
// at different times otherwise get different weights → non-reproducible
// embeddings) and record it in a cache marker. DI-04: LFS weights must be
// sha256-verified at fetch time. All via seams — CI never touches the network.
describe('model revision pin + checksum marker (DI-03/DI-04)', () => {
  const MINILM = MODEL_CONFIGS.minilm.name;
  const MINILM_REV = '751bff37182d3f1213fa05d7196b954e230abad9';
  const BGE_REV = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'deepindex-rev-'));
    process.env.DEEPINDEX_MODEL_CACHE_DIR = join(tmp, 'cache');
  });

  afterEach(() => {
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('MODEL_CONFIGS pins revisions for both models (DI-03)', () => {
    expect(MODEL_CONFIGS.minilm.revision).toBe(MINILM_REV);
    expect(MODEL_CONFIGS.bge.revision).toBe(BGE_REV);
  });

  it('resolveModelRevision maps model name → pin, undefined for unknown (DI-03)', async () => {
    const mod = await import('../src/semantic/embedder.js');
    expect(mod.resolveModelRevision?.(MINILM)).toBe(MINILM_REV);
    expect(mod.resolveModelRevision?.('Xenova/unknown')).toBeUndefined();
  });

  it('fetchModel passes the pinned revision to the pipeline and writes the marker (DI-03)', async () => {
    const mod = await import('../src/semantic/embedder.js');
    const seen: Array<{ task: string; model: string; opts?: { revision?: string } }> = [];
    const factory = async (task: string, model: string, opts?: { revision?: string }): Promise<unknown> => {
      seen.push({ task, model, opts });
      mkdirSync(join(tmp, 'cache', model), { recursive: true });
      return {};
    };
    await mod.fetchModel(MINILM, { pipelineFactory: factory });
    expect(seen).toEqual([
      { task: 'feature-extraction', model: MINILM, opts: { revision: MINILM_REV } },
    ]);
    const markerPath = join(tmp, 'cache', MINILM, '.deepindex-model.json');
    expect(existsSync(markerPath)).toBe(true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(marker.model).toBe(MINILM);
    expect(marker.revision).toBe(MINILM_REV);
  });

  it('fetchModel sha256-verifies present LFS weights against the tree listing (DI-04)', async () => {
    const mod = await import('../src/semantic/embedder.js');
    const sha = createHash('sha256').update('weights-bytes').digest('hex');
    const factory = async (_task: string, model: string): Promise<unknown> => {
      const dir = join(tmp, 'cache', model);
      mkdirSync(join(dir, 'onnx'), { recursive: true });
      writeFileSync(join(dir, 'onnx', 'model.onnx'), 'weights-bytes');
      writeFileSync(join(dir, 'config.json'), '{}');
      return {};
    };
    const tree = [
      { path: 'onnx/model.onnx', sha256: sha },
      { path: 'config.json' }, // non-LFS → no sha, skipped
    ];
    await mod.fetchModel(MINILM, { pipelineFactory: factory, treeFetch: async () => tree });
    const marker = JSON.parse(
      readFileSync(join(tmp, 'cache', MINILM, '.deepindex-model.json'), 'utf8')
    );
    expect(marker.verified).toEqual([{ path: 'onnx/model.onnx', sha256: sha }]);
  });

  it('fetchModel refuses on a checksum mismatch (DI-04)', async () => {
    const mod = await import('../src/semantic/embedder.js');
    const factory = async (_task: string, model: string): Promise<unknown> => {
      const dir = join(tmp, 'cache', model);
      mkdirSync(join(dir, 'onnx'), { recursive: true });
      writeFileSync(join(dir, 'onnx', 'model.onnx'), 'tampered-bytes');
      return {};
    };
    const sha = createHash('sha256').update('weights-bytes').digest('hex');
    await expect(
      mod.fetchModel(MINILM, {
        pipelineFactory: factory,
        treeFetch: async () => [{ path: 'onnx/model.onnx', sha256: sha }],
      })
    ).rejects.toThrow(/checksum mismatch/);
  });

  it('loadRealEmbedder warns when the cached marker revision differs from the pin (DI-03)', async () => {
    const mod = await import('../src/semantic/embedder.js');
    const dir = join(tmp, 'cache', 'Xenova/bge-small-en-v1.5');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.deepindex-model.json'),
      JSON.stringify({
        model: 'Xenova/bge-small-en-v1.5',
        revision: 'deadbeef',
        verified: [],
        fetchedAt: '2020-01-01T00:00:00Z',
      })
    );
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The behavior under test is the WARNING firing before any load work.
    // Whether the load then succeeds (transformers mocked by an earlier
    // describe) or rejects (not installed) is environment-dependent — catch
    // both, assert the warning.
    await mod.loadRealEmbedder('Xenova/bge-small-en-v1.5').catch(() => undefined);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('revision'));
    warnSpy.mockRestore();
  });
});
