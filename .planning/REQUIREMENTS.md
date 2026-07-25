# Requirements: ContextKit

## Validated

(None yet — ship to validate)

## Active (v1)

### Graph (GRPH)

- [ ] **GRPH-01**: Build symbol/import graph for TS/JS/Python files via tree-sitter into SQLite. Tables: files, symbols, imports, edges.
- [ ] **GRPH-02**: Hash-based file invalidation. Re-parse only changed files. Detect moves/renames via hash match.
- [ ] **GRPH-03**: Resolve relative imports to file paths within the indexed repo. Track unresolved as broken-import candidates.
- [ ] **GRPH-04**: BFS traversal from any symbol returns dependents (who imports me) and dependencies (who do I import).

### Summarize (SUMM)

- [ ] **SUMM-01**: Generate per-folder summary.md aggregating exported symbols, main entry points, and dependencies. LLM-free version: lists symbols + first line of each file. LLM version: one paragraph per folder.
- [ ] **SUMM-02**: Regenerate summary only when folder hash changes. Store last hash in SQLite.

### Fingerprint (FNGR)

- [ ] **FNGR-01**: Every context object has {hash, version, confidence, size, updatedAt}. Compute on write. Returned on read.
- [ ] **FNGR-02**: Confidence score derived from deterministic signals: source file hash stability, import resolution success rate, test pass count.

### Cache (CACH)

- [ ] **CACH-01**: Hash-keyed context store in SQLite. Set(key, content, fingerprint). Get(key) returns content if hash matches.
- [ ] **CACH-02**: LRU eviction on size cap (default 100MB). Eviction logged, never silent.

### Health (HLTH)

- [ ] **HLTH-01**: Deterministic health score: freshness (mtime/hash), broken imports (graph unresolved count), missing symbols, test status (parse vitest output), schema drift (migration count).
- [ ] **HLTH-02**: Threshold config. Below threshold → trigger repair. Above → serve context without LLM.
- [ ] **HLTH-03**: Health output is JSON: {score, dimensions: {freshness, consistency, coverage, confidence}, issues: [...]}.

### Retrieve (RTRV)

- [ ] **RTRV-01**: Keyword search over indexed files. Tokenize, score by term frequency + symbol match.
- [ ] **RTRV-02**: Graph BFS from seed symbols returns top-N related files. Combine with keyword score, return top-K.
- [ ] **RTRV-03**: Returned payload is minimal: file path, relevant symbols, summary excerpt, no full file body unless requested.

### Repair (REPR)

- [ ] **REPR-01**: Deterministic repair first. Missing symbol → graph search. Broken import → re-resolve. Outdated doc → git history.
- [ ] **REPR-02**: OpenAI-compatible client as last resort. Prompt assembled by PromptAssembler. Response written back to context cache.
- [ ] **REPR-03**: Repair never invoked unless health < threshold. Logged with reason and cost (tokens if known).

### Reflect (RFLT)

- [ ] **RFLT-01**: Parse vitest output → test pass/fail/skip counts. Feed into health.
- [ ] **RFLT-02**: Parse eslint output → error/warning counts. Feed into health.
- [ ] **RFLT-03**: Parse coverage report → line/branch coverage %. Feed into confidence.

### Watcher (WTCH)

- [ ] **WTCH-01**: chokidar watches repo. File save/add/delete → invalidate affected summaries, re-parse file, update graph.
- [ ] **WTCH-02**: Debounce events (250ms). Coalesce rapid saves. Log invalidated count.
- [ ] **WTCH-03**: Respects .gitignore by default. --no-ignore flag to override.

### Adapter (ADPT)

- [ ] **ADPT-01**: adapter-claude-code module. Input: user task. Output: minimal context (top-K retrieved files, summaries, graph neighborhood). Drop-in for Claude Code prompts.

### CLI (CMD)

- [ ] **CMD-01**: `ctx build` — index repo, generate summaries, write SQLite.
- [ ] **CMD-02**: `ctx status` — print health JSON, exit 0 if healthy, exit 1 if not.
- [ ] **CMD-03**: `ctx repair` — trigger deterministic + LLM repair path. Print before/after health.
- [ ] **CMD-04**: `ctx serve` — start HTTP server (port 7331) returning context JSON for given task. Adapter endpoint.
- [ ] **CMD-05**: `ctx watch` — start fs watcher, print events as they invalidate cache.
- [ ] **CMD-06**: `ctx retrieve <query>` — print top-K files for query. No LLM. Use for debugging.

### Tests (TEST)

- [ ] **TEST-01**: vitest unit tests for graph, cache, fingerprint, health modules.
- [ ] **TEST-02**: fixtures/sample-repo with intentional broken import. Verify health detects, repair fixes.
- [ ] **TEST-03**: One end-to-end smoke: `ctx build` → `ctx status` → `ctx retrieve` on sample repo. Must pass.

## Out of Scope (v2+)

- Embeddings / vector retrieval — keyword + graph BFS first
- Web UI / dashboard — CLI only
- Languages beyond py/ts/js — defer until asked
- Anthropic-native SDK — generic OpenAI client covers all proxies
- Auto-fix code — harness's job, not framework's
- Multi-machine sync — single-machine first
- Git hooks for auto-build — chokidar covers runtime, hooks optional later

## Definition of Done (per phase)

- Code in `src/`, types in `src/types/`, tests in `tests/`
- All active requirements for the phase checked off
- `pnpm test` passes
- One end-to-end smoke run recorded in `fixtures/`
- One runnable self-check per non-trivial module

## Traceability

Mapped to phases in ROADMAP.md.
