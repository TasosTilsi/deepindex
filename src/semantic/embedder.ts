import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SemanticConfig } from './config.js';

// Embedder CONTRACT + runtime (D-22/D-23/D-24/D-24b). @huggingface/transformers
// ships as an OPTIONAL dependency (DI-01, reversing EMBD-07): default installs
// get the vector layer, `--omit=optional` escapes it, and the module still
// loads through a lazy dynamic import (variable specifier — TypeScript never
// resolves its types and absence degrades to SemanticUnavailableError instead
// of a build error). There is NO auto-download (D-23): the model enters the
// cache only via fetchModel() — the ONLY network path in the codebase,
// invoked exclusively by the explicit `deepindex embed --fetch-model`
// bootstrap. Unit tests inject fakes/spies so CI never touches native code
// or the network.

export interface Embedder {
  /** Model identifier, e.g. 'Xenova/all-MiniLM-L6-v2'. */
  model: string;
  /** Vector dimensionality this embedder produces (384 for both configs). */
  dim: number;
  /** Embed a batch of texts into unit-normalized vectors. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Raised when the semantic layer cannot run: the optional
 *  @huggingface/transformers dependency is absent, or the native runtime
 *  fails to load. Callers degrade to lexical-only with a warning — this
 *  error never crashes indexing or search (RSK-4). Message carries the
 *  install hint so users can self-serve. */
export class SemanticUnavailableError extends Error {
  constructor(message: string) {
    super(
      `embedder: semantic layer unavailable — ${message} (install hint: pnpm add @huggingface/transformers)`
    );
    this.name = 'SemanticUnavailableError';
  }
}

export interface ModelConfig {
  /** HuggingFace model id used with transformers.js. */
  name: string;
  /** Embedding dimension (D-21b: both models are 384d → one vec dim). */
  dim: number;
  /** Pinned HuggingFace revision sha (DI-03): transformers.js otherwise
   *  resolves the repo's CURRENT default revision — two machines fetching at
   *  different times get different weights → non-reproducible embeddings. */
  revision: string;
}

/** Supported embedding models (D-24): MiniLM is the default; bge-small is
 *  selectable via the `semantic.model` config. Keys match the config values
 *  accepted in `.deepindex.toml` `[semantic] model = ...`. Revisions are the
 *  HuggingFace repo commit shas at pin time (DI-03). */
export const MODEL_CONFIGS: Record<'minilm' | 'bge', ModelConfig> = {
  minilm: {
    name: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  },
  bge: {
    name: 'Xenova/bge-small-en-v1.5',
    dim: 384,
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
  },
};

export const DEFAULT_MODEL_KEY: keyof typeof MODEL_CONFIGS = 'minilm';

/** Single source of truth for model names downstream (embed() default,
 *  hybridSearch in plan 03, the --fetch-model bootstrap). */
export function resolveModelName(config: SemanticConfig): string {
  return MODEL_CONFIGS[config.model].name;
}

/** Revision pin for a model NAME (DI-03): single source is MODEL_CONFIGS.
 *  Unknown names (tests, exotic models) → undefined — callers fall back to
 *  transformers.js default-revision behavior. */
export function resolveModelRevision(model: string): string | undefined {
  for (const cfg of Object.values(MODEL_CONFIGS)) {
    if (cfg.name === model) return cfg.revision;
  }
  return undefined;
}

/** Exact bootstrap command embedded in every refusal/hint message (D-23). */
export const FETCH_MODEL_COMMAND = 'deepindex embed --fetch-model';

/** Model cache dir: ~/.deepindex/models, overridable for tests (D-23).
 *  Cache layout is `<cacheDir>/<org>/<name>` — HuggingFace model ids already
 *  carry the org, so join(cacheDir, model) is the marker path. */
export function modelCacheDir(): string {
  return process.env.DEEPINDEX_MODEL_CACHE_DIR ?? join(homedir(), '.deepindex', 'models');
}

/** True when the model has been fetched into the cache dir (D-23 gate). */
export function hasCachedModel(model: string): boolean {
  return existsSync(join(modelCacheDir(), model));
}

/** One file from the HF tree listing, as far as verification cares (DI-04). */
export interface ModelTreeFile {
  path: string;
  /** sha256 for LFS-stored files (weights); absent for plain-text files. */
  sha256?: string;
}

/** Cache marker persisted beside the downloaded weights (DI-03/DI-04):
 *  records WHICH revision was fetched and which files were checksum-verified,
 *  so a later load can warn on pin drift (never crash, never re-download —
 *  D-23 keeps the load path network-free). */
export interface ModelMarker {
  model: string;
  revision: string | null;
  verified: { path: string; sha256: string }[];
  fetchedAt: string;
}

/** Marker path: <cacheDir>/<model>/.deepindex-model.json (the model id
 *  already carries the org, matching the cache layout). */
export function modelMarkerPath(model: string): string {
  return join(modelCacheDir(), model, '.deepindex-model.json');
}

/** Read the fetch-time marker; null when absent or unparseable. */
export function readModelMarker(model: string): ModelMarker | null {
  try {
    return JSON.parse(readFileSync(modelMarkerPath(model), 'utf8')) as ModelMarker;
  } catch {
    return null;
  }
}

/** HF tree listing for a model at a revision (DI-04): LFS entries carry a
 *  sha256 (lfs.oid) usable for local file verification. Only called from
 *  fetchModel — the sanctioned network path (D-23). */
async function fetchModelTree(model: string, revision?: string): Promise<ModelTreeFile[]> {
  const rev = revision ?? 'main';
  const res = await fetch(
    `https://huggingface.co/api/models/${model}/tree/${rev}?recursive=true`
  );
  if (!res.ok) {
    throw new Error(`HF tree API ${res.status} for ${model}@${rev}`);
  }
  const entries = (await res.json()) as Array<{
    path: string;
    lfs?: { oid: string };
  }>;
  return entries.map((e) => ({ path: e.path, sha256: e.lfs?.oid }));
}

/** Verify every PRESENT cached LFS file against its tree sha256 (DI-04).
 *  Files transformers.js did not download are skipped (only fetched
 *  artifacts matter); non-LFS files carry no sha256 (the pipeline's
 *  successful load is their check). A mismatch is a hard refusal — a
 *  tampered cache must not silently produce different embeddings. */
function verifyCachedFiles(
  model: string,
  files: ModelTreeFile[]
): { path: string; sha256: string }[] {
  const root = join(modelCacheDir(), model);
  const verified: { path: string; sha256: string }[] = [];
  for (const f of files) {
    if (!f.sha256) continue;
    const local = join(root, f.path);
    if (!existsSync(local)) continue;
    const actual = createHash('sha256').update(readFileSync(local)).digest('hex');
    if (actual !== f.sha256) {
      throw new SemanticUnavailableError(
        `model fetch checksum mismatch for ${model}/${f.path} (expected ${f.sha256}, got ${actual}) — cache may be corrupt; delete ${root} and re-run ${FETCH_MODEL_COMMAND}`
      );
    }
    verified.push({ path: f.path, sha256: f.sha256 });
  }
  return verified;
}

/** Minimal structural typing for the dynamic import — the real package is
 *  optional and never exercised in CI. */
interface TransformersModule {
  pipeline: (
    task: string,
    modelName: string,
    opts?: { revision?: string }
  ) => Promise<unknown>;
  env: { cacheDir: string; allowLocalModels: boolean };
}

interface Extractor {
  (texts: string[], opts: { pooling: string; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
}

async function importTransformers(): Promise<TransformersModule> {
  const specifier = '@huggingface/transformers';
  try {
    return (await import(specifier)) as TransformersModule;
  } catch (e) {
    throw new SemanticUnavailableError(
      `@huggingface/transformers is not installed (${e instanceof Error ? e.message : String(e)})`
    );
  }
}

/** DOWNLOAD SEAM (D-23, DI-03, DI-04): runs the transformers.js
 *  feature-extraction pipeline once for `model` at the PINNED revision — the
 *  pipeline constructor downloads on a cache miss into env.cacheDir
 *  (POC-proven). loadRealEmbedder refuses on an empty cache, so the download
 *  lives HERE, outside that gate. Calling it on an already-cached model is a
 *  cheap re-validate. `opts.pipelineFactory` is the CI-safe test seam: tests
 *  inject a factory that writes the cache marker — no test ever hits the
 *  network. After the pipeline run, present LFS weights are sha256-verified
 *  (DI-04) and the revision marker is persisted (DI-03). */
export async function fetchModel(
  model: string,
  opts: {
    pipelineFactory?: (
      task: string,
      modelName: string,
      opts?: { revision?: string }
    ) => Promise<unknown>;
    /** Tree-listing seam (DI-04): tests inject fakes; production calls
     *  fetchModelTree. Verification is skipped when only pipelineFactory is
     *  injected (bare factory = CI mode, zero network). */
    treeFetch?: (model: string, revision?: string) => Promise<ModelTreeFile[]>;
  } = {}
): Promise<void> {
  const revision = resolveModelRevision(model);
  try {
    if (opts.pipelineFactory) {
      await opts.pipelineFactory('feature-extraction', model, { revision });
    } else {
      const tf = await importTransformers();
      tf.env.cacheDir = modelCacheDir();
      tf.env.allowLocalModels = true;
      await tf.pipeline('feature-extraction', model, revision ? { revision } : undefined);
    }
  } catch (e) {
    if (e instanceof SemanticUnavailableError) throw e;
    throw new SemanticUnavailableError(
      `model fetch failed for ${model}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!hasCachedModel(model)) {
    throw new SemanticUnavailableError(
      `model ${model} was not cached after fetch — expected marker at ${join(modelCacheDir(), model)}`
    );
  }
  // DI-04: sha256-verify present LFS weights, then persist the revision
  // marker (DI-03).
  let verified: { path: string; sha256: string }[] = [];
  if (!opts.pipelineFactory || opts.treeFetch) {
    try {
      const files = opts.treeFetch
        ? await opts.treeFetch(model, revision)
        : await fetchModelTree(model, revision);
      verified = verifyCachedFiles(model, files);
    } catch (e) {
      if (e instanceof SemanticUnavailableError) throw e;
      throw new SemanticUnavailableError(
        `model verification failed for ${model}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  const marker: ModelMarker = {
    model,
    revision: revision ?? null,
    verified,
    fetchedAt: new Date().toISOString(),
  };
  writeFileSync(modelMarkerPath(model), JSON.stringify(marker, null, 2) + '\n');
}

/** Real-model runtime. NO auto-download (D-23): an empty cache refuses with
 *  the exact fetch command. Both supported models are BERT-family v1.5/v2 —
 *  no query-side instruction prefix (OQ-7): queries and docs embed
 *  identically, mean-pooled and unit-normalized.
 *  REVIEW-FIX W4: memoized per model name — a long-lived MCP/serve process
 *  must not re-run the ONNX pipeline constructor (hundreds of ms) per query.
 *  The PROMISE is cached (not the instance) so concurrent callers share one
 *  load; failures evict the entry (a transient load error stays retryable). */
const realEmbedderCache = new Map<string, Promise<Embedder>>();

export function loadRealEmbedder(model: string): Promise<Embedder> {
  if (!hasCachedModel(model)) {
    return Promise.reject(
      new SemanticUnavailableError(
        `model ${model} is not cached — run ${FETCH_MODEL_COMMAND} first (cache dir: ${modelCacheDir()})`
      )
    );
  }
  let cached = realEmbedderCache.get(model);
  if (!cached) {
    cached = loadRealEmbedderUncached(model);
    realEmbedderCache.set(model, cached);
    cached.catch(() => realEmbedderCache.delete(model));
  }
  return cached;
}

async function loadRealEmbedderUncached(model: string): Promise<Embedder> {
  const revision = resolveModelRevision(model);
  // DI-03: warn on pin drift — never crash, never download from here (D-23
  // keeps the load path local-only; re-running --fetch-model re-pins).
  const marker = readModelMarker(model);
  if (revision && marker?.revision && marker.revision !== revision) {
    console.error(
      `embedder: cached model ${model} is revision ${marker.revision} but this deepindex pins ${revision} — embeddings may not be reproducible. Re-run ${FETCH_MODEL_COMMAND} to re-pin.`
    );
  }
  const tf = await importTransformers();
  tf.env.cacheDir = modelCacheDir();
  tf.env.allowLocalModels = true;
  const extractor = (await tf.pipeline(
    'feature-extraction',
    model,
    revision ? { revision } : undefined
  )) as Extractor;
  return {
    model,
    dim: 384,
    embed: async (texts) => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist();
    },
  };
}

/** THE SHARED RESOLVER — used by embed() and by hybridSearch (plan 03).
 *  Precedence: opts.embedder (fake injection, D-24b) → opts.loader (loader-
 *  spy injection, HOOK-04) → cache gate: cached model loads for real, empty
 *  cache refuses with FETCH_MODEL_COMMAND (D-23 gate lives here once, not
 *  duplicated at call sites). */
export async function getEmbedder(
  model: string,
  opts: { embedder?: Embedder; loader?: (m: string) => Promise<Embedder> } = {}
): Promise<Embedder> {
  if (opts.embedder) return opts.embedder;
  if (opts.loader) return opts.loader(model);
  if (hasCachedModel(model)) return loadRealEmbedder(model);
  throw new SemanticUnavailableError(
    `model ${model} is not cached — run ${FETCH_MODEL_COMMAND} first`
  );
}