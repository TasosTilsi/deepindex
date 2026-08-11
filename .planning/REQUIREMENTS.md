# Requirements: DeepIndex

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

## Active (v2 — Merge)

**Cross-cutting (locked 2026-08-09):** one SQLite store for all indexes
(schema v3); LLM optional — every requirement below must be satisfiable
without any LLM call. LLM summarization/extraction is a configurable
enrichment, gated on config, never a dependency.

### Multi-Language (MLNG)

- [ ] **MLNG-01**: Extend tree-sitter parsing to java, c/c++, go, rust (web-tree-sitter WASM grammars). Same symbol extraction walker, per-language node-type→normalized-type tables.
- [ ] **MLNG-02**: Language detection by extension; unknown languages skipped with a count.
- [ ] **MLNG-03**: Complexity heuristic per file (keyword-count) for the new languages, matching existing py/ts/js.

### Data-Flow (DFLW)

- [x] **DFLW-01**: Extract SQL statements (SELECT/INSERT/UPDATE/DELETE/CREATE TABLE/ALTER/DROP) from code + XML/YAML configs. Store query text + referenced tables (JSON array).
- [x] **DFLW-02**: Extract CREATE TABLE column schemas (paren-depth comma splitter). One row per column.
- [x] **DFLW-03**: Extract ORM annotations (@Table, @Entity, __tablename__) and MongoDB collections (@Document, db.collection, getCollection).
- [x] **DFLW-04**: Extract config mappings (MyBatis resultMap, PropertyNameMapper) and data constants (hardcoded rates/IDs/keys from .properties/JSON).

### Data-Flow Graph (DGRPH)

- [x] **DGRPH-01**: Project index → data-flow graph: Table/Query/Service/File nodes + READS_FROM/WRITES_TO/CONTAINS/MAPS_TO edges. Tiny adjacency map + BFS (no NetworkX).
- [ ] **DGRPH-02**: Service detection from file paths (%Service%, %Controller%, %Repository%) with service_type.
- [ ] **DGRPH-03**: Graph persisted in SQLite (graph_nodes/graph_edges) alongside the symbol graph.

### Impact (IMPT)

- [x] **IMPT-01**: `impact <table>` — walk in-edges: queries reading/writing the table, files containing those queries, services affected. No hardcoded counts.
- [ ] **IMPT-02**: Change-type awareness (add_column/modify/delete) reflected in the impact report.

### Parallel Storage (PSTR)

- [ ] **PSTR-01**: `parallel-storage` — group tables by domain tag, flag domains with >1 storage system (e.g. DB2 + MongoDB).

### Context Tagging (CTXT)

- [ ] **CTXT-01**: Auto-tag tables/queries/files with domain/region/system by keyword + regex. Generic dictionaries (not cobi's insurance/tax-specific ones).
- [ ] **CTXT-02**: Every data-flow/graph query accepts --domain/--region/--system filters.

### Requirements (REQ)

- [ ] **REQ-01**: Requirements tables (requirements, atomic_requirements, requirement_code_links) in the same SQLite store.
- [ ] **REQ-02**: `index-requirements` ingests JSON (from external Jira/Confluence sync); atomic-statement extraction + classification.
- [ ] **REQ-03**: `req-coverage` — traceability report: requirements without code, code without requirements.

### Git Extractor (GITX)

- [ ] **GITX-01**: Walk git history oldest-first via child_process (git log/diff). Skip merge commits, cap diff at 4000 chars.
- [ ] **GITX-02**: Batch commits (default 10) per extraction batch — deterministic heuristic extraction is the default; LLM batch extraction is optional enrichment when configured.
- [ ] **GITX-03**: Sanitize raw diffs before LLM (high-entropy + pattern detection, [REDACTED:type]).

### Entities (ENTY)

- [ ] **ENTY-01**: Two extraction paths. Deterministic heuristic (commit subject + changed file paths → typed entities) is the required default; LLM batch extraction prompt + JSON schema (entities: [{type, name, content, commit_sha}]) is optional enrichment. Strip fences, filter types, lowercase names.
- [ ] **ENTY-02**: Entity types: decision, bug_fix, pattern, file, concept, tech_debt. CHECK constraint.
- [ ] **ENTY-03**: Dedup by UUID5(type:name) + INSERT OR IGNORE. Commit rows persist real message/author/date (fix Recall's stubs).

### Backlinks (BKLN)

- [ ] **BKLN-01**: Extraction also returns relationships [{from, to, label, context}]; backlinks written bidirectionally (inverse trigger). Relationships derivable deterministically (shared files/co-occurrence) when LLM off.
- [ ] **BKLN-02**: 1-hop traversal from any entity returns related entities with relationship label + context.

### FTS Search (FTS)

- [ ] **FTS-01**: FTS5 external-content table over entities (name, content) with sync triggers.
- [ ] **FTS-02**: `search <query>` returns typed entities via FTS5, ranked, with related entities via backlinks.

### Incremental Sync (SYNC)

- [ ] **SYNC-01**: `git-sync` processes commits since last_indexed_sha (metadata cursor); auto-inits if no DB.
- [ ] **SYNC-02**: `git-index` full rebuild; SHA-not-found falls back to full re-index with warning.

### MCP Server (MCP)

- [ ] **MCP-01**: `ctx mcp serve` — stdio MCP server, stderr-only logging, stdout clean.
- [ ] **MCP-02**: 6 read-only tools: search_knowledge, get_entity, get_backlinks, get_decisions, get_bugs, get_patterns.
- [ ] **MCP-03**: Tools query the merged store (symbols + data-flow + entities).

### Hooks (HOOK)

- [ ] **HOOK-01**: SessionStart hook — incremental git sync (≤5s).
- [ ] **HOOK-02**: UserPromptSubmit hook — context injection (FTS-first, ≤6s).
- [ ] **HOOK-03**: PostToolUse capture + SessionEnd summary; additive install into project .claude/settings.json.

## Out of Scope (v2+)

- Embeddings / vector retrieval — keyword + graph BFS first
- Web UI / dashboard — CLI only; Recall's UI is reference, not ported
- Anthropic-native SDK — generic OpenAI client covers all proxies
- Auto-fix code — harness's job, not framework's
- Multi-machine sync — single-machine first
- Git hooks for auto-build — chokidar covers runtime, hooks optional later
- Mermaid diagram generation — cobi's is mostly placeholder
- Recall v3.2 extras: RAG chat, hierarchical synthesis, world map
- cobi/Recall legacy code: cobi cli.py/search/, Recall graphiti/queue/retention

## Definition of Done (per phase)

- Code in `src/`, types in `src/types/`, tests in `tests/`
- All active requirements for the phase checked off
- `pnpm test` passes
- One end-to-end smoke run recorded in `fixtures/`
- One runnable self-check per non-trivial module

## Traceability

Mapped to phases in ROADMAP.md.
