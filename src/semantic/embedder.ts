import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SemanticConfig } from './config.js';

// Embedder CONTRACT + runtime (D-22/D-23/D-24/D-24b). @huggingface/transformers
// is NOT a core dependency (EMBD-07): the module is loaded through a lazy
// dynamic import (variable specifier — TypeScript never resolves its types
// and absence degrades to SemanticUnavailableError instead of a build error).
// There is NO auto-download (D-23): the model enters the cache only via
// fetchModel() — the ONLY network path in the codebase, invoked exclusively
// by the explicit `deepindex embed --fetch-model` bootstrap. Unit tests
// inject fakes/spies so CI never touches native code or the network.

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
}

/** Supported embedding models (D-24): MiniLM is the default; bge-small is
 *  selectable via the `semantic.model` config. Keys match the config values
 *  accepted in `.deepindex.toml` `[semantic] model = ...`. */
export const MODEL_CONFIGS: Record<'minilm' | 'bge', ModelConfig> = {
  minilm: { name: 'Xenova/all-MiniLM-L6-v2', dim: 384 },
  bge: { name: 'Xenova/bge-small-en-v1.5', dim: 384 },
};

export const DEFAULT_MODEL_KEY: keyof typeof MODEL_CONFIGS = 'minilm';

/** Single source of truth for model names downstream (embed() default,
 *  hybridSearch in plan 03, the --fetch-model bootstrap). */
export function resolveModelName(config: SemanticConfig): string {
  return MODEL_CONFIGS[config.model].name;
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

/** Minimal structural typing for the dynamic import — the real package is
 *  optional and never installed in CI. */
interface TransformersModule {
  pipeline: (task: string, modelName: string) => Promise<unknown>;
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

/** DOWNLOAD SEAM (D-23): runs the transformers.js feature-extraction pipeline
 *  once for `model` — the pipeline constructor downloads on a cache miss into
 *  env.cacheDir (POC-proven). loadRealEmbedder refuses on an empty cache, so
 *  the download lives HERE, outside that gate. Calling it on an already-
 *  cached model is a cheap re-validate. `opts.pipelineFactory` is the CI-safe
 *  test seam: tests inject a factory that writes the cache marker — no test
 *  ever hits the network. */
export async function fetchModel(
  model: string,
  opts: { pipelineFactory?: (task: string, modelName: string) => Promise<unknown> } = {}
): Promise<void> {
  try {
    if (opts.pipelineFactory) {
      await opts.pipelineFactory('feature-extraction', model);
    } else {
      const tf = await importTransformers();
      tf.env.cacheDir = modelCacheDir();
      tf.env.allowLocalModels = true;
      await tf.pipeline('feature-extraction', model);
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
}

/** Real-model runtime. NO auto-download (D-23): an empty cache refuses with
 *  the exact fetch command. Both supported models are BERT-family v1.5/v2 —
 *  no query-side instruction prefix (OQ-7): queries and docs embed
 *  identically, mean-pooled and unit-normalized. */
export async function loadRealEmbedder(model: string): Promise<Embedder> {
  if (!hasCachedModel(model)) {
    throw new SemanticUnavailableError(
      `model ${model} is not cached — run ${FETCH_MODEL_COMMAND} first (cache dir: ${modelCacheDir()})`
    );
  }
  const tf = await importTransformers();
  tf.env.cacheDir = modelCacheDir();
  tf.env.allowLocalModels = true;
  const extractor = (await tf.pipeline('feature-extraction', model)) as Extractor;
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