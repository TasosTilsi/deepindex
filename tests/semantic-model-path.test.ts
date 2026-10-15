import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticConfig } from '../src/semantic/config.js';
import { MODEL_CONFIGS } from '../src/semantic/embedder.js';

/**
 * Offline model path (#6) and the checksum verification path (#14).
 *
 * #6: semantic search needs a model that `embed --fetch-model` downloads from
 * HuggingFace. In an air-gapped or egress-restricted environment there was no way to
 * point the embedder at a local export, short of editing source. `[semantic] model_path`
 * plus `DEEPINDEX_MODEL_PATH` close that, and the load path must then make no network
 * request at all.
 *
 * #14: `verifyCachedFiles` hashed `<cacheDir>/<model>/<path>` while a revision-pinned
 * fetch stores files at `<cacheDir>/<model>/<revision>/<path>` (transformers.js keys its
 * cache that way), so every candidate failed `existsSync` and the marker recorded
 * `verified: []` — DI-04's verification was a silent no-op.
 *
 * Every test here is network-free: the pipeline is mocked, `fetch` is stubbed, and the
 * tree listing is injected.
 */
const MODEL = MODEL_CONFIGS.minilm.name;
const REVISION = MODEL_CONFIGS.minilm.revision!;

function localExport(dir: string, opts: { quantizedOnly?: boolean } = {}): string {
  const root = join(dir, 'local-export');
  mkdirSync(join(root, 'onnx'), { recursive: true });
  writeFileSync(join(root, 'config.json'), '{}\n');
  writeFileSync(join(root, 'tokenizer.json'), '{}\n');
  writeFileSync(join(root, 'tokenizer_config.json'), '{}\n');
  const weight = opts.quantizedOnly ? 'model_quantized.onnx' : 'model.onnx';
  writeFileSync(join(root, 'onnx', weight), 'weights\n');
  return root;
}

/** Activates the mocked pipeline and returns the spies it recorded. */
async function mockTransformers(cacheDir: string) {
  const calls: Array<{ task: string; modelName: string; opts?: Record<string, unknown> }> = [];
  const env = { cacheDir, allowLocalModels: true, allowRemoteModels: true, useFSCache: true };
  const fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  vi.doMock('@huggingface/transformers', () => ({
    pipeline: async (task: string, modelName: string, opts?: Record<string, unknown>) => {
      calls.push({ task, modelName, opts });
      return async (texts: string[]) => ({ tolist: () => texts.map(() => new Array(384).fill(0.5)) });
    },
    env,
  }));
  vi.resetModules();
  const embedder = await import('../src/semantic/embedder.js');
  return { embedder, calls, env, fetchSpy };
}

describe('semantic config: model_path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-modelpath-'));

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a quoted and a bare model_path, and ignores an empty value', () => {
    writeFileSync(
      join(dir, '.deepindex.toml'),
      '[semantic]\nenabled = true\nmodel_path = "/opt/models/minilm"\n'
    );
    expect(loadSemanticConfig(dir).modelPath).toBe('/opt/models/minilm');

    writeFileSync(
      join(dir, '.deepindex.toml'),
      '[semantic]\nenabled = true\nmodel_path = ./models/minilm\n'
    );
    // A relative path resolves against the repository root, not the cwd.
    expect(loadSemanticConfig(dir).modelPath).toBe(join(dir, 'models/minilm'));

    writeFileSync(join(dir, '.deepindex.toml'), '[semantic]\nenabled = true\nmodel_path = ""\n');
    expect(loadSemanticConfig(dir).modelPath).toBeUndefined();
  });

  it('lets DEEPINDEX_MODEL_PATH override the toml value', () => {
    writeFileSync(
      join(dir, '.deepindex.toml'),
      '[semantic]\nenabled = true\nmodel_path = "/opt/from-toml"\n'
    );
    process.env.DEEPINDEX_MODEL_PATH = '/opt/from-env';
    expect(loadSemanticConfig(dir).modelPath).toBe('/opt/from-env');
    delete process.env.DEEPINDEX_MODEL_PATH;
  });

  it('omits modelPath entirely when nothing is configured', () => {
    writeFileSync(join(dir, '.deepindex.toml'), '[semantic]\nenabled = true\n');
    // Assert the field is absent rather than pinning the object's shape and key order.
    expect(loadSemanticConfig(dir).modelPath).toBeUndefined();
    rmSync(join(dir, '.deepindex.toml'));
  });
});

describe('model_path loading', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deepindex-modelpath-load-'));

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_PATH;
    vi.unstubAllGlobals();
    vi.resetModules();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads a local export with local_files_only and never touches the network', async () => {
    const exportDir = localExport(join(tmp, 'a'));
    const { embedder, calls, env, fetchSpy } = await mockTransformers(join(tmp, 'cache-a'));

    const loaded = await embedder.loadRealEmbedder(MODEL, { modelPath: exportDir });

    expect(loaded.model).toBe(MODEL);
    expect(calls).toHaveLength(1);
    expect(calls[0].modelName).toBe(exportDir);
    expect(calls[0].opts).toMatchObject({ local_files_only: true });
    expect(env.allowRemoteModels).toBe(false);
    expect(env.useFSCache).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('loads a quantized-only export with dtype q8', async () => {
    const exportDir = localExport(join(tmp, 'b'), { quantizedOnly: true });
    const { embedder, calls } = await mockTransformers(join(tmp, 'cache-b'));

    await embedder.loadRealEmbedder(MODEL, { modelPath: exportDir });

    expect(calls[0].opts).toMatchObject({ local_files_only: true, dtype: 'q8' });
  });

  it('refuses a broken model_path without any network attempt', async () => {
    const { embedder, fetchSpy } = await mockTransformers(join(tmp, 'cache-c'));

    await expect(embedder.loadRealEmbedder(MODEL, { modelPath: join(tmp, 'nope') })).rejects.toThrow(
      /model_path .* not found — semantic search disabled/
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keys the embedder memo by model_path', async () => {
    const first = localExport(join(tmp, 'd1'));
    const second = localExport(join(tmp, 'd2'));
    const { embedder, calls } = await mockTransformers(join(tmp, 'cache-d'));

    const a = await embedder.loadRealEmbedder(MODEL, { modelPath: first });
    const b = await embedder.loadRealEmbedder(MODEL, { modelPath: second });

    expect(calls).toHaveLength(2);
    expect(a.embed).not.toBe(b.embed);
  });

  it('reports the exact validation messages', async () => {
    const { embedder } = await mockTransformers(join(tmp, 'cache-e'));

    // The message is the contract the user reads; the shape carries only ok/message.
    expect(embedder.checkModelPath(join(tmp, 'missing'))).toEqual({
      ok: false,
      message: `model_path ${join(tmp, 'missing')} not found — semantic search disabled`,
    });

    const bare = join(tmp, 'bare');
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'config.json'), '{}\n');
    const result = embedder.checkModelPath(bare);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/onnx\/model\.onnx/);
  });
});

describe('default cache path forbids remote fetches', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deepindex-nonet-'));

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    vi.resetModules();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('sets allowRemoteModels=false so a partial cache cannot silently re-download', async () => {
    const cacheDir = join(tmp, 'cache');
    mkdirSync(join(cacheDir, MODEL), { recursive: true });
    process.env.DEEPINDEX_MODEL_CACHE_DIR = cacheDir;
    const { embedder, env, fetchSpy } = await mockTransformers(cacheDir);

    await embedder.loadRealEmbedder(MODEL);

    expect(env.allowRemoteModels).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('DI-04 checksum verification', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'deepindex-verify-'));

  afterAll(() => {
    delete process.env.DEEPINDEX_MODEL_CACHE_DIR;
    rmSync(tmp, { recursive: true, force: true });
  });

  it('verifies weights inside the revision directory and records them in the marker', async () => {
    const cacheDir = join(tmp, 'cache-rev');
    const weightDir = join(cacheDir, MODEL, REVISION, 'onnx');
    mkdirSync(weightDir, { recursive: true });
    const weight = 'model-onnx-bytes';
    writeFileSync(join(weightDir, 'model.onnx'), weight);
    const sha256 = createHash('sha256').update(weight).digest('hex');
    process.env.DEEPINDEX_MODEL_CACHE_DIR = cacheDir;

    const { embedder } = await mockTransformers(cacheDir);
    await embedder.fetchModel(MODEL, {
      pipelineFactory: async () => undefined,
      treeFetch: async () => [{ path: 'onnx/model.onnx', sha256 }],
    });

    const marker = JSON.parse(readFileSync(embedder.modelMarkerPath(MODEL), 'utf8')) as {
      verified: { path: string; sha256: string }[];
    };
    expect(marker.verified).toEqual([{ path: 'onnx/model.onnx', sha256 }]);
  });

  it('still refuses a tampered weight', async () => {
    const cacheDir = join(tmp, 'cache-bad');
    const weightDir = join(cacheDir, MODEL, REVISION, 'onnx');
    mkdirSync(weightDir, { recursive: true });
    writeFileSync(join(weightDir, 'model.onnx'), 'tampered');
    process.env.DEEPINDEX_MODEL_CACHE_DIR = cacheDir;

    const { embedder } = await mockTransformers(cacheDir);
    await expect(
      embedder.fetchModel(MODEL, {
        pipelineFactory: async () => undefined,
        treeFetch: async () => [
          { path: 'onnx/model.onnx', sha256: createHash('sha256').update('original').digest('hex') },
        ],
      })
    ).rejects.toThrow(/checksum mismatch/);
  });
});
