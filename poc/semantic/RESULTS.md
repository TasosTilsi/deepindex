# POC results: semantic search (poc/semantic-search branch)

Date: 2026-09-07. Scripts: `poc/semantic/embed.mjs` + `poc/semantic/search.mjs`.
Deps (temp): resolved from `bench-tmp/node_modules` — `@huggingface/transformers` + `sqlite-vec` not yet in package.json. Full bench context in `bench-tmp/bench.mjs`.

## Hard numbers (this repo's DB: 82 entities + 295 symbols = 377 docs)

| Metric | Value |
|---|---|
| Model | all-MiniLM-L6-v2 q8, 384d — 23.7MB disk, ~200MB RSS in-process, 4s load |
| Full re-embed | 2.7s @ ~135 docs/s |
| Re-run (hash guard) | 0 embedded / 377 skipped ✓ (sha256 content hashes in `poc_embed_meta`) |
| Query latency | ~1ms embed + KNN |
| Vector store | ~0.6MB in the same `.deepindex.db` |
| sqlite-vec 0.1.9 | loads via better-sqlite3 `loadExtension` ✓; **declared-PK vec0 inserts broken** → auto-rowid vec tables + `poc_embed_meta(doc_id, kind, hash, model, vec_rowid)` mapping (works, hash-guarded, stale-vector delete on change) |
| KNN distance | vec0 default = L2 (fine: monotonic-equivalent to cosine on normalized vectors) |

## Quality (informal — 8 hand-picked queries, single corpus)

- Paraphrase queries: vec finds targets FTS5 misses entirely (3-4/6 vs 1/6). E.g. "stop build crashing when language grammar file missing" → `skip-files-whose-grammar-wasm-isn-t-vendored` (FTS: noise).
- Symbol code-intent search (no lexical baseline exists today): consistent top-1-3 hits — "evict least recently used" → `evictIfNeeded` (src/cache.ts); "walk git history and extract entities" → `commitsAfter`/`extractDeterministic`; grammar query → `GrammarUnavailableError` class.
- Hybrid RRF (semantic + FTS5, k=60) merges both without demoting the target.

## Extended corpora (2026-09-07, "how does it work" sources)

Corpus 377 → **628 docs** (82 entities + 295 symbols + 57 module cards + 194 markdown chunks), 7.2s embed.

- **Module cards** — synthesized from existing graph rows: exports/imports-out/imported-by/tables per code file. Zero new parsing.
- **Markdown chunks** — heading-split docs (README/USAGE/DESIGN/ADRs): 194 chunks. This is the biggest "how does it work" win — ADRs were invisible to both FTS and vec before.
- **Docstrings** — line-scan above symbol start: only **34/295 symbols have any comment text** — this repo is light on doc comments; extraction works, the raw material is thin. Prod phase should capture comments properly in `parse.ts`.

Result: "how does the tool decide when to ask an LLM" now routes to `docs/adr/0002-llm-optional.md` chunks + `stage4LLM`/`LLMClient`/`repair` symbols — previously only commit-slugs. "What happens when a file is saved during watch" → USAGE.md chunk + `src/watcher.ts` card + `createWatcher`.

## Caveats

Hand-picked queries (selection bias), one corpus, one model, L2-vs-cosine note above. Decision gate should be: 30-50 queries including your own real ones.

## How to evaluate yourself

```
node poc/semantic/search.mjs "<your question in your own words>" --k 5
```

Judge: does the top-5 contain what you'd have looked for? Compare the semantic vs lexical blocks. If semantic rarely surfaces something lexical missed for YOUR queries — skip phase 8; if it does — implement phase 8 (D-20..D-28 proposals, model via explicit fetch — user decision 2026-09-07).