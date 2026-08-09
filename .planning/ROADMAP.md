# Roadmap: ContextKit

**[6] phases** | **[29] v1 + [36] v2 requirements mapped** | All v1 requirements covered ✓

| # | Phase | Goal | Requirements | Success Criteria |
|---|-------|------|--------------|------------------|
| 1 | Foundation: Graph + Fingerprint + Cache | Build the persistent state layer. SQLite schema, tree-sitter parsing, hash-based invalidation, hash-keyed cache. | GRPH-01..04, FNGR-01..02, CACH-01..02 | 5 |
| 2 | Health + Retrieve + Repair + Reflect | Decision loop. Deterministic health checks, hybrid retrieval, deterministic-first repair with LLM fallback, static-analysis reflection. | HLTH-01..03, RTRV-01..03, REPR-01..03, RFLT-01..03 | 5 |
| 3 | Watcher + Adapter + CLI + Tests | Surface the system. chokidar event loop, claude-code adapter, commander CLI, vitest suite with fixture. | WTCH-01..03, ADPT-01, CMD-01..06, TEST-01..03 | 5 |
| 4 | Merge: Data-Flow & Multi-Language Indexing | Absorb cobi's code indexing. Multi-language symbols, SQL/data-flow extraction, data-flow graph, impact + parallel-storage, context tagging, requirements traceability. | MLNG-01..03, DFLW-01..04, DGRPH-01..03, IMPT-01..02, PSTR-01, CTXT-01..02, REQ-01..03 | 5 |
| 5 | Merge: Git-History Knowledge Graph | Absorb Recall's temporal knowledge. Git walker, deterministic-first extraction (LLM optional), typed entities + backlinks, FTS5 search, incremental sync. | GITX-01..03, ENTY-01..03, BKLN-01..02, FTS-01..02, SYNC-01..02 | 5 |
| 6 | Merge: Unified Interfaces | Surface merged knowledge. MCP server, Claude hooks, unified CLI/HTTP. UI deferred. | MCP-01..03, HOOK-01..03 | 5 |

**Total**: 6 phases, 29 v1 + 36 v2 requirements, 30 success criteria.

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
1. `getHealth(repoPath)` returns JSON with {score, dimensions, issues}. Score = 80 on a clean fixture. Score drops on fixture with broken import.
2. Repair on a broken-import fixture: deterministic path re-resolves imports first, reports success without LLM call. Logged.
3. Repair path with deterministic failure: OpenAI-compatible client invoked, response cached, token count logged.
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

---

### Phase 4: Merge: Data-Flow & Multi-Language Indexing
**Goal**: Absorb cobi-tool's code-indexing capabilities. Multi-language tree-sitter symbols (java/c/go/rust), SQL/data-flow extraction (CREATE TABLE, queries, ORM, config mappings, data constants), data-flow graph (Table↔Query↔Service↔File), impact analysis, parallel-storage detection, context tagging, requirements traceability. cobi is a code indexing tool, not only data-flow — absorb its full indexing.

**Requirements**: MLNG-01, MLNG-02, MLNG-03, DFLW-01, DFLW-02, DFLW-03, DFLW-04, DGRPH-01, DGRPH-02, DGRPH-03, IMPT-01, IMPT-02, PSTR-01, CTXT-01, CTXT-02, REQ-01, REQ-02, REQ-03

**Success Criteria**:
1. `ctx build` indexes java/c/go/rust symbols via web-tree-sitter; symbol search returns them.
2. `ctx list-tables` lists every table/collection discovered (CREATE TABLE, ORM, Mongo); `ctx find-table-usage <table>` returns code that reads/writes it.
3. `ctx build-graph` projects data-flow graph; `ctx impact <table>` lists affected queries/files/services (no hardcoded 0).
4. `ctx parallel-storage` flags tables stored in >1 system (e.g. DB2 + MongoDB).
5. `ctx req-coverage` reports requirements without code and code without requirements.

**Mode**: standard

---

### Phase 5: Merge: Git-History Knowledge Graph
**Goal**: Absorb Recall's temporal knowledge. Git walker (oldest-first, skip merges, diff cap), deterministic-first extraction with LLM batch extraction as optional enrichment (10 commits/call when enabled), typed entities (decision, bug_fix, pattern, file, concept, tech_debt) with bidirectional backlinks, FTS5 search, incremental sync via last_indexed_sha. Fix Recall's dead backlinks — extraction also returns relationships. LLM never required (locked 2026-08-09).

**Requirements**: GITX-01, GITX-02, GITX-03, ENTY-01, ENTY-02, ENTY-03, BKLN-01, BKLN-02, FTS-01, FTS-02, SYNC-01, SYNC-02

**Success Criteria**:
1. `ctx git-index` walks full git history, extracts typed entities (deterministic heuristics by default, LLM batch extraction when enabled), dedups by UUID5(type:name).
2. `ctx git-sync` processes only commits since last_indexed_sha; auto-inits if no DB.
3. Entities have bidirectional backlinks with relationship label + context (extraction returns relationships).
4. `ctx search <query>` returns typed entities via FTS5 with related entities via backlinks.
5. Raw diffs sanitized before LLM (high-entropy + pattern detection, [REDACTED:type]).

**Mode**: standard

---

### Phase 6: Merge: Unified Interfaces
**Goal**: Surface the merged knowledge. MCP server (stdio, 6 read-only tools), 4 Claude Code hooks (SessionStart git sync, UserPromptSubmit context injection, PostToolUse capture, SessionEnd summary), unified CLI/HTTP surface. UI deferred (ctx YAGNI).

**Requirements**: MCP-01, MCP-02, MCP-03, HOOK-01, HOOK-02, HOOK-03

**Success Criteria**:
1. `ctx mcp serve` starts stdio MCP server; 6 read-only tools registered; stdout clean (stderr-only logging).
2. MCP tools query the merged store (symbols + data-flow + entities).
3. Hooks installed into project `.claude/settings.json`; SessionStart syncs git, UserPromptSubmit injects context.
4. Unified CLI: one binary, one `--db`, verbs for build/status/retrieve/repair/serve/watch + data-flow + git-history.
5. Adapter + serve endpoint return merged context (symbols + data-flow + entities).

**Mode**: standard
