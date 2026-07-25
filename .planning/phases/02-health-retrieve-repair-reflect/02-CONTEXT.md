---
phase: 2
name: Health + Retrieve + Repair + Reflect
date: 2026-07-25
---

# Phase 2 Context: Health + Retrieve + Repair + Reflect

## Domain

Decision loop. Deterministic health gates every LLM call. Retrieval assembles
minimal context. Repair handles gaps (deterministic first, LLM last).
Reflection feeds external tool output (tests, lint, coverage) back into
health. All as library functions in `src/` — no CLI in this phase (phase 3).

## Spec Source / Framing

- `.planning/REQUIREMENTS.md` — HLTH-01..03, RTRV-01..03, REPR-01..03, RFLT-01..03
- `context-engineering-article.txt` (Adnan Masood, Jun 2025) — project framing
  doc. Article principles 1, 4, 5, 6, 7 map directly to this phase:
  - Principle 1 (dynamic context) → RTRV-01..03
  - Principle 4 (window management) → RTRV-03 (minimal payload, top-K=10)
  - Principle 5 (quality/relevance) → RTRV-02 (combined ranking)
  - Principle 6 (memory + repair) → REPR-01..03
  - Principle 7 (RAG integration) → REPR-02 (LLM as last-resort)
  - Pungas quote (ref [8]): "context engineering is information retrieval" —
    no embeddings in v1, TF-IDF + graph proximity only.

## Reusable assets (from phase 1)

- `getDependencies` / `getDependents` BFS in `src/graph/query.ts` — already
  handles RTRV-02 graph BFS in both directions.
- `Import.resolved` boolean in DB — already tracks broken imports for
  HLTH-01 consistency dim.
- `FingerprintSignals` interface in `src/types.ts` — already declares
  `importsResolved` and `testsPass` slots that HLTH-01 confidence and RFLT
  plug into.
- `cacheSet` / `cacheGet` — hash-keyed, LRU-evicting; REPR-02 response cache
  reuses without change.
- `buildGraph` in `src/graph/build.ts` — REPR-01 stage 1 (re-build) calls it.
- `commander` in `src/cli.ts` — phase 3 expands commands; phase 2 stays
  library-only.
- Better-sqlite3 connection helpers in `src/graph/db.ts` — new `health_signals`
  table added in same DB, no new file.

## Decisions

### Health scoring (HLTH-01..03)

- Composite score: weighted average of 4 dimensions, each 0..1, default weights:
  - `score = 0.30·freshness + 0.30·consistency + 0.20·coverage + 0.20·confidence`
- Dimension formulas (explicit, no pluggable scorers in v1):
  - `freshness = files_parsed_recently / total_files`
  - `consistency = 1 - broken_imports / total_imports` (0 if no imports)
  - `coverage = (tests_pass / (tests_pass + tests_fail)) · (1 - lint_errors / total_lint_issues)`
  - `confidence = 0.5·imports_resolved + 0.5·tests_pass_rate`
- Missing source data for a dim → dim defaults to **0.5** (neutral).
  Rationale: triggers repair early to gather evidence; cost of one early
  LLM call is lower than cost of stale-passing health on day 0.
- Output JSON shape: `{score, dimensions: {freshness, consistency, coverage,
  confidence}, issues: [{type, message, location?}]}`. `score` is 0..100
  (rounded int).
- Threshold for repair trigger: composite `score < 80`, configurable via
  `.ctx.toml` section `[health] repair_below = 80`. Below threshold = repair
  runs; above = serve context without LLM.

### Repair pipeline (REPR-01..03)

- 4-stage linear pipeline, each stage returns `{ok, actions[]}`:
  1. **Re-build**: call `buildGraph(repo)` to re-parse changed files,
     re-resolve imports, populate new symbols. Catches most broken-import
     issues without LLM.
  2. **Cache invalidate**: `cacheDelete(key)` for every cache key whose
     referenced symbolId or fileId no longer exists in graph. Prevents
     serving stale summaries.
  3. **Git history probe**: for any docstring/issue claiming "X is the case",
     run `git log -p -- <file>` and check if the claim is contradicted by
     recent commits. Lightweight, regex-based, deterministic.
  4. **LLM call** (last resort, only fires if stages 1-3 didn't restore
     score ≥ threshold). Uses `OpenAICompatibleClient`.
- LLM gate: fires only when composite health < threshold AND previous
  stage didn't restore health AND an LLM is configured. Logged with
  reason + cost (token counts from response).
- LLM client shape: `OpenAICompatibleClient({baseUrl, apiKey, model})` →
  POST `{baseUrl}/chat/completions` with `{messages: [{role, content}],
  model}`. Response: `{content: string, usage: {prompt_tokens,
  completion_tokens}}`. Works for OpenAI, Ollama, LM Studio, llama.cpp.
- Response cache: `cacheSet('repair:' + hash(prompt), content,
  fingerprint)` — never re-pays for the same repair.
- LLM only invoked when explicitly enabled via config + score below
  threshold. No silent LLM calls.

### Retrieval (RTRV-01..03)

- Seed symbols: `getSymbolByName(db, name)` matched against query tokens
  (lowercase, split on whitespace + punctuation, dedupe). Case-insensitive.
- Graph expansion: from seed symbols, BFS `getDependents` to depth 2 →
  union of files containing seeds + dependent files.
- Per-file score:
  - `tfidf(file, query)` — term frequency × inverse-doc-frequency over
    file path + exported symbol names + first-line-of-symbol text. Simple
    in-process implementation, no external tokenizer.
  - `graph_proximity(file) = 1 / (1 + min_bfs_depth_to_any_seed)`
  - `score(file) = 0.6 · tfidf + 0.4 · graph_proximity`
- Top-K = argsort desc, default K=10, configurable via `retrieve` arg.
- Payload (RTRV-03, minimal): `{path, score, symbols: [{name, kind,
  startLine, endLine, exported}], summary: <generated from first line
  of each symbol>}`. No file body in payload.

### Reflect (RFLT-01..03)

- Three pure parser functions, strict JSON input shapes:
  - `parseVitestJson(json) → {pass, fail, skip, total, durationMs}`
    Input: vitest JSON reporter output (`vitest --reporter=json`).
  - `parseEslintJson(json) → {errors, warnings, total, files}`
    Input: eslint JSON formatter output (`eslint --format=json`).
  - `parseCoverageJson(json) → {linesPct, branchesPct, functionsPct}`
    Input: istanbul `coverage-final.json`.
- Storage: new SQLite table in same DB:
  ```sql
  CREATE TABLE health_signals (
    key TEXT PRIMARY KEY,       -- 'tests', 'lint', 'coverage_lines', etc.
    value REAL NOT NULL,        -- 0..1
    source TEXT,                -- 'vitest', 'eslint', 'coverage'
    updated_at INTEGER NOT NULL
  );
  ```
- API: `recordSignal(db, key, value, source)`, `getSignals(db) → Record<key,
  value>`. Health module reads on every `getHealth()`.
- Phase 2 ships parsers + signals + tests. Phase 3 wires the CLI commands
  that invoke the tools and pipe JSON in.

## Out of scope (v1)

- No CLI commands (phase 3).
- No watcher (phase 3).
- No vector embeddings / semantic search. TF-IDF + graph only.
- No prompt-injection scanning on retrieved content.
- No Neo4j / graph DB. SQLite only. Revisit if graph >100k nodes.
- No multi-agent / sub-orchestrator. Linear pipeline in-process.
- No vector store. No external memory DB.

## Deferred ideas (backlog)

- Neo4j / Memgraph — if graph scale or Cypher needed.
- Vector embeddings — if TF-IDF recall is measurably insufficient.
- Prompt-injection scanner on retrieved content.
- Long-term session memory (external to ContextKit; per-call only).
- Auto-watch tool output (auto-run vitest on file change).
- Per-dim thresholds (instead of one composite).
- Per-folder health (drill-down by directory).
- Coverage-over-time trend (track `confidence` history).

## Canonical refs

- `.planning/PROJECT.md` — project mission, key decisions, target users
- `.planning/REQUIREMENTS.md` — HLTH/RTRV/REPR/RFLT reqs
- `.planning/phases/01-foundation/01-VALIDATION.md` — phase 1 test coverage,
  confirms GRPH-01..04, FNGR-01..02, CACH-01..02 are stable inputs
- `context-engineering-article.txt` — Masood 2025, framing + IR-first
  rationale
- `src/graph/query.ts` — `getDependencies` / `getDependents` (reused)
- `src/graph/db.ts` — schema, initDb (extended with health_signals)
- `src/cache.ts` — `cacheSet` / `cacheGet` (reused for repair cache)
- `src/graph/build.ts` — `buildGraph` (reused in repair stage 1)
- `src/types.ts` — `FingerprintSignals` (reused for confidence dim)
- `package.json` — `commander` is already a dep (CLI expansion in phase 3)

## Code context

- All new code in `src/health.ts`, `src/retrieve.ts`, `src/repair.ts`,
  `src/reflect.ts` (top-level modules; phase 1 used `src/graph/` subdir
  for parser, but these are flat cross-cutting concerns).
- Tests in `tests/health.test.ts`, `tests/retrieve.test.ts`,
  `tests/repair.test.ts`, `tests/reflect.test.ts`.
- Extend `src/index.ts` to re-export new modules.
- Extend `src/graph/db.ts` `SCHEMA` to include `health_signals` table +
  bump `SCHEMA_VERSION` from 1 → 2. Migration on init.

## Validation targets (from ROADMAP.md success criteria)

1. `getHealth(repoPath)` returns JSON `{score, dimensions, issues}`. Score
   = 100 on clean fixture. Score drops on fixture with broken import.
2. Repair on broken-import fixture: stage 1 re-builds, reports success
   without LLM call. Logged.
3. Repair path with deterministic failure: OpenAI-compatible client
   invoked, response cached, health restored. Token count logged.
4. Retrieve on 10-file fixture with query "auth" returns top-3 files
   containing auth-related symbols. Verified by symbol containment.
5. Reflect: `parseVitestJson` updates `tests` dim, `parseEslintJson`
   updates `lint` (via `coverage` analog), `parseCoverageJson` updates
   `confidence`. Verified by feeding sample outputs and checking
   `getHealth()`.
