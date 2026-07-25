# Roadmap: ContextKit

**[3] phases** | **[29] requirements mapped** | All v1 requirements covered ✓

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Foundation: Graph + Fingerprint + Cache | Build the persistent state layer. SQLite schema, tree-sitter parsing, hash-based invalidation, hash-keyed cache. | GRPH-01..04, FNGR-01..02, CACH-01..02 | 5 |
| 2 | Health + Retrieve + Repair + Reflect | Decision loop. Deterministic health checks, hybrid retrieval, deterministic-first repair with LLM fallback, static-analysis reflection. | HLTH-01..03, RTRV-01..03, REPR-01..03, RFLT-01..03 | 5 |
| 3 | Watcher + Adapter + CLI + Tests | Surface the system. chokidar event loop, claude-code adapter, commander CLI, vitest suite with fixture. | WTCH-01..03, ADPT-01, CMD-01..06, TEST-01..03 | 5 |

**Total**: 3 phases, 29 v1 requirements, 15 success criteria.

---

## Phase Details

### Phase 1: Foundation: Graph + Fingerprint + Cache
**Goal**: Build the persistent state layer that everything else reads from. After this phase, the framework can index a repo, hash files, store context, and read it back. No LLM, no health checks, no CLI commands beyond a minimal `ctx build`.

**Requirements**: GRPH-01, GRPH-02, GRPH-03, GRPH-04, FNGR-01, FNGR-02, CACH-01, CACH-02

**Success Criteria**:
1. `ctx build <repo>` walks a TS/JS/Python repo, parses files via tree-sitter, populates SQLite with files/symbols/imports/edges tables. Exits 0.
2. Re-running `ctx build` skips files whose hash hasn't changed. Verified by timing second run < first run on a 50+ file repo.
3. `getDependents(symbolId)` and `getDependencies(symbolId)` return correct BFS results on a fixture with known graph shape.
4. Cache stores arbitrary context objects keyed by hash. Re-storing same content is a no-op (hash match). Re-storing mutated content writes new version.
5. Fingerprint module returns `{hash, version, confidence, size, updatedAt}` for any context object. Stable across runs.

**Mode**: standard

---

### Phase 2: Health + Retrieve + Repair + Reflect
**Goal**: Make the framework self-evaluating. Deterministic health gates every LLM call. Retrieval assembles minimal context. Repair handles gaps deterministically first, via LLM last. Reflection uses static analysis as ground truth.

**Requirements**: HLTH-01, HLTH-02, HLTH-03, RTRV-01, RTRV-02, RTRV-03, REPR-01, REPR-02, REPR-03, RFLT-01, RFLT-02, RFLT-03

**Success Criteria**:
1. `getHealth(repoPath)` returns JSON with {score, dimensions, issues}. Score = 100 on a clean fixture. Score drops on fixture with broken import.
2. Repair on a broken-import fixture: deterministic path re-resolves imports first, reports success without LLM call. Logged.
3. Repair path with deterministic failure: OpenAI-compatible client invoked, response cached, health restored. Token count logged.
4. Retrieve on a 10-file fixture with query "auth" returns top-3 files containing auth-related symbols. Verified by symbol containment in result.
5. Reflect: feeding vitest JSON output updates health dimension `tests`. Feeding eslint output updates `lint`. Coverage updates `confidence`.

**Mode**: standard

---

### Phase 3: Watcher + Adapter + CLI + Tests
**Goal**: Make the framework usable from any CLI harness. Watcher drives incremental updates. Adapter exposes context for Claude Code. CLI commands cover build/status/repair/serve/watch/retrieve. Tests prove the end-to-end loop on a real fixture.

**Requirements**: WTCH-01, WTCH-02, WTCH-03, ADPT-01, CMD-01, CMD-02, CMD-03, CMD-04, CMD-05, CMD-06, TEST-01, TEST-02, TEST-03

**Success Criteria**:
1. `ctx watch` starts chokidar, on file save prints "invalidated: <file>", regenerates affected summary, exits cleanly on SIGINT.
2. `ctx serve` accepts POST /context {task, repoPath}, returns JSON with top-K files, summaries, graph neighborhood. Verified via curl.
3. adapter-claude-code: given user task, returns same JSON shape as serve endpoint. Drop-in consumable by Claude Code prompt.
4. `pnpm test` runs all vitest tests. Coverage ≥ 70% on src/. Fixture-based tests for graph/health/retrieve/repair all green.
5. End-to-end smoke: `pnpm run smoke` runs build → status → retrieve on fixtures/sample-repo. Exits 0, prints health JSON + top-K files.

**Mode**: standard
