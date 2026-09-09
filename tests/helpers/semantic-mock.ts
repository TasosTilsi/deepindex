import type { Embedder } from '../../src/semantic/embedder.js';

// Topic-lexicon fake embedder (D-24b — CI never touches a native model).
// Each topic maps to one vector dimension; a text's vector is the normalized
// sum of one-hot topic hits. Synonyms share a topic, so a query can rank a
// doc whose text shares NO lexical token with the query — the paraphrase
// property SRSR-01 demands, deterministically.

export const TOPICS: Record<string, number> = {
  storage: 0,
  cache: 0,
  database: 0,
  persist: 0,
  persistent: 0,
  durable: 0,
  durability: 0,
  auth: 1,
  token: 1,
  session: 1,
  login: 1,
  network: 2,
  http: 2,
  retry: 2,
  timeout: 2,
};

export function topicVec(text: string): number[] {
  const v = new Array<number>(384).fill(0);
  for (const tok of text.toLowerCase().split(/[^a-z]+/)) {
    const t = TOPICS[tok];
    if (t !== undefined) v[t] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function topicEmbedder(model = 'fake'): Embedder {
  return { model, dim: 384, embed: async (texts) => texts.map(topicVec) };
}

/** vi.mock factory for '@huggingface/transformers' — a fake feature-extraction
 *  pipeline whose vectors come from the SAME topicVec as the injected
 *  embedder, so the real loadRealEmbedder path (cache gate + dynamic import)
 *  is exercisable end-to-end in CI. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeTransformersMock(): Record<string, any> {
  return {
    pipeline: async () =>
      async (texts: string[], _opts?: unknown) =>
        Promise.resolve({ tolist: () => texts.map(topicVec) }),
    env: { cacheDir: '', allowLocalModels: true },
  };
}