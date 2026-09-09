# ADR-0010: Semantic Retrieval & Embeddings (sqlite-vec + hybrid search)

- **Status:** Accepted
- **Date:** 2026-09-09
- **Phase:** 08 v3 — Semantic Retrieval & Embeddings (decisions D-20..D-29, requirements EMBD/SRSR/KSRC/HOOK-04/DASH)

## Context

Retrieval was lexical-only: FTS5 bm25 at the entity level (`searchEntities`) and TF-IDF + graph proximity at the file level (`retrieve()`), never merged. A paraphrase — a query that shares no token with an entity's name or content — could not find that entity. A POC on branch `poc/semantic-search` (merged into `phase-8`; `poc/semantic/{embed.mjs,search.mjs,RESULTS.md}` are evidence-only) proved the full pattern end-to-end on this repo's own index: 628 docs embedded in 7.2s, re-run 0/628 with a hash guard, 1ms/query embed+KNN with a q8 MiniLM.

Two empirical facts — verified by running code, not reading docs — shaped the design:

1. **sqlite-vec 0.1.9 rejects declared primary keys** on vec0 virtual tables (`Only integers are allows for primary key values on t_pk`) and **rejects the `distance_metric=cosine` table option** (`vec0 constructor error: Unknown table option: distance_metric`). The official docs site documents `distance_metric` only for the 0.1.10-alpha line — do not chase it.
2. **`@huggingface/transformers` drags a heavyweight native stack** (`onnxruntime-node`, `sharp`) into every install; a semantic layer that silently downloads models on first use would break CI and betray the local-first, no-surprises contract.

## Decision

Add a semantic retrieval layer inside the existing per-project SQLite store — no standalone vector DB (LanceDB/Qdrant rejected, D-20):

- **Schema v6 (D-21):** `embeddings_meta` is a plain table created by `initDb`; the vec0 tables (`entity_vecs`, `symbol_vecs`, `doc_vecs`, `embedding float[384]`) are created **lazily** by `ensureVecTables(db)`, which loads the sqlite-vec extension **per connection**. `initDb` never requires the extension — readonly watcher handles and serve db copies keep working. Declared-PK inserts are broken at this pin, so vec tables use **auto-rowid** and `embeddings_meta` maps each doc to its `(kind, vec_rowid)`; every lookup filters on `(kind, vec_rowid)` because each table has its own rowid sequence. Both MiniLM and bge-small are 384d, so one vec dim serves all models; model+dim are recorded per row and a mismatch triggers a full re-embed with a warning (D-21b).
- **Pluggable embedder (D-22/D-24):** interface `{ model, dim, embed(texts) }` in `src/semantic/embedder.ts`; transformers.js is a **dynamic import, not a core dep** (D-24b) — absence raises `SemanticUnavailableError` with an install hint and index/search are unaffected. Model selection is config-aware: `[semantic].model` in `.deepindex.toml` resolves through `resolveModelName(loadSemanticConfig(repoPath))` — surfaces never thread model names. Default `Xenova/all-MiniLM-L6-v2`; `Xenova/bge-small-en-v1.5` optional (both 384d; v1.5 needs no query-side instruction — embed queries and documents identically).
- **Explicit fetch bootstrap (D-23):** no auto-download. The model is fetched only on `deepindex embed --fetch-model`, cached at `~/.deepindex/models`; offline or uncached → the layer disables itself with a warning pointing at the exact command.
- **Hash-guarded lifecycle (D-25/D-26):** embedded text is chunked per knowledge source (symbol spans + docstrings, entity type+name+content, module cards, markdown heading-chunks); sha256 per row; re-runs embed 0 unchanged docs; a changed file re-embeds only its affected docs. Auto-embed runs after index/git-sync when the model is cached and `semantic.enabled` (D-26b), budget-capped inside the sessionStart hook chain (D-26c, D-29: sessionStart = auto-sync point; the watcher stays invalidate-only).
- **Hybrid search (D-28):** typed `HybridHit { kind, id, label, path?, score, snippet?, source }` — RRF fusion with k=60 (Cormack/Clarke/Buettcher, SIGIR 2009) over FTS5 entity hits, vec KNN, and `retrieve()` file hits (which keep `source: 'graph'`; `retrieve()` itself is untouched). `source` discriminates provenance: `vec` / `lexical` / `graph`.

## Consequences

- **Positive:** paraphrase recall at zero token cost; degradation is total — `semantic.enabled=false` or empty vec tables returns the lexical path **byte-identical**, pinned by test (SRSR-03). L2 distance on normalized vectors is monotonic with cosine, so ranking is correct and display converts via `cos = 1 − d²/2`.
- **Version pin:** sqlite-vec is pinned at **0.1.9** (npm latest stable, POC-verified against better-sqlite3 11.10.0). The auto-rowid + meta-mapping shape is mandatory at this pin; upgrading past 0.1.9 must re-verify vec0 semantics before touching the store layer.
- **Async search contract:** `hybridSearch` and `handleApi` are `async` because the embedder contract is async — every call site (CLI, MCP, serve) awaits them. Phase-9 work must keep this shape.
- **Score semantics (UI):** hybrid-mode scores are RRF sums (max 3/61 ≈ 0.049 when a hit tops all three fused lists — never cosine scale), so UI `rrf` badges are never accent-thresholded; `cos` badges with the ≥0.35 accent apply only in semantic mode.
- **Phase-9 ATTACH note (SRSR-04):** the extension loads per connection, so vec0 KNN over ATTACHed project DBs works automatically once `ensureVecTables` ran on that connection — build nothing now; the design already carries it.
- **Negative:** one more native-ish dependency (`sqlite-vec`, tiny, 5-platform optionalDeps) and a `~/.deepindex/models` cache to reason about; the real-model path is exercised only by manual smoke (CI uses fake-embedder injection), so model behaviour changes surface outside CI first.

## Alternatives considered

- **Standalone vector DB (LanceDB / Qdrant):** rejected — a second store to run, back up, and keep consistent with the `.deepindex.db` source of truth; sqlite-vec keeps vectors transactional with the graph rows they mirror (D-20).
- **`@huggingface/transformers` as a core dependency:** rejected — its dependency tree (`onnxruntime-node` 1.24.3, `sharp`) would tax every install for an optional enrichment layer; dynamic import + explicit fetch keeps CI download-free (D-24b/D-23).
- **Upgrading sqlite-vec for the `distance_metric=cosine` option:** rejected — that option exists only on the 0.1.10-alpha line; alpha vec0 semantics may break the POC-verified auto-rowid pattern, and normalized L2 already ranks identically.
- **LLM-side embeddings (OpenAI-compatible API):** moved to backlog (EMBD-03) — violates local-first/no-API-key and adds per-call cost to a deterministic pipeline.
- **Auto-embed as a separate CLI step only:** rejected in discussion — embedding inside the index/git-sync pipeline (budget-capped in hooks) keeps vec tables fresh without a new ritual (D-26b/D-29).