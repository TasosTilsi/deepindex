// Embedder CONTRACT ONLY in this task — no model runtime here. The
// transformers.js dynamic import, cache-dir handling and the explicit
// --fetch-model gate live in a later plan; everything downstream codes
// against this interface so tests can inject a fake embedder (D-24b: CI
// never touches a native model).

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
      `embedder: semantic layer unavailable — ${message} (install hint: npm install @huggingface/transformers)`
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