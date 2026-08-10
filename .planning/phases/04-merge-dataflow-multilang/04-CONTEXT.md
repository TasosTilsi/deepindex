---
phase: 4
name: Merge — Data-Flow & Multi-Language Indexing
date: 2026-08-10
---

# Phase 04: Merge — Data-Flow & Multi-Language Indexing - Context

**Gathered:** 2026-08-10
**Status:** Ready for planning

<domain>

## Phase Boundary

Absorb cobi-tool's code-indexing capabilities into ContextKit. cobi is a Python codebase-indexing CLI + Claude plugin: multi-language tree-sitter symbol extraction, SQL/data-flow extraction, an embedded knowledge graph (Table↔Query↔Service↔File), impact analysis, parallel-storage detection, context tagging, and Jira/Confluence requirements traceability.

The user's framing: **cobi is a code indexing tool, not only for data.**
The merge absorbs its full indexing capability — symbols, complexity, data-flow, graph, impact, requirements — not just the data-flow slice.

This phase ports those ideas to TypeScript on top of ContextKit's existing symbol/import graph. Adds: multi-language parsing (java/c/go/rust), SQL/query/ORM/config extraction, data-flow graph, impact + parallel-storage queries, context tagging, requirements tables.

</domain>

<decisions>

## Implementation Decisions

### Multi-Language Scope
- **D-07:** Full Cobi scope. Port all 8 languages (TS, JS, Py, Java, C/C++, Go, Rust). Use web-tree-sitter WASM grammars.

### Requirements Sync
- **D-13:** Hybrid sync. Port full sync toolset. If Atlassian MCP is present and connected, search/fetch and index from Jira/Confluence directly. If not, skip and rely on external JSON feeds.

### SQL Extraction
- **D-14:** Dual-path extraction. Implement both Regex-only (Cobi way) and formal SQL Parser paths. Let LLM or AI tool decide which to use based on query complexity.

### Data-Flow Graph
- **D-15:** Dual-engine graph. Implement the tiny adjacency map + BFS for standard use. Also support Neo4j for massive repos, provided it can be installed locally without Docker.

### Locked (from prior discussions)
- **D-01:** Home repo = context-engineering-framework.
- **D-02:** Stack = TypeScript.
- **D-03:** Absorb full indexing (not just data-flow).
- **D-04:** Discuss → Plan → Implement.
- **D-05:** One database (SQLite schema v3).
- **D-06:** LLM optional (deterministic-first).

</decisions>

<canonical_refs>

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — new MLNG/DFLW/DGRPH/IMPT/PSTR/CTXT/REQ groups
- `.planning/ROADMAP.md` — Phase 4 success criteria
- `.planning/PROJECT.md` — merged mission

### Reference implementations (Python, do not port code — port ideas)
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/sql_parser.py` — SQL/query/ORM/config extraction regexes
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/db_indexer.py` — SQLite schema + incremental indexer
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/graph_builder.py` — index → graph projection
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/graph_queries.py` — impact, parallel-storage, trace
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/core/context_analyzer.py` — domain/region/system tagging
- `/home/tasostilsi/Development/Projects/cobi-tool/cobi/requirements/` — requirement indexer + extractor

### Existing ContextKit code to extend
- `src/graph/db.ts` — schema v2 → v3 (add data-flow tables)
- `src/graph/build.ts` — add data-flow extraction pass
- `src/parser.ts` (or `src/graph/parser.ts`) — add language grammars
- `src/cli.ts` — add data-flow verbs

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets
- `better-sqlite3`: used for all graph and cache storage.
- `web-tree-sitter`: used for TS/JS/Py; expand to others.
- `cacheSet`/`cacheGet`: hash-keyed storage usable for extraction results.

### Established Patterns
- Two-pass build: first insert files, then parse.
- Deterministic health signals trigger repair.
- Adapter-based context injection for Claude Code.

### Integration Points
- `ctx build`: primary entry point for new indexers.
- `ctx retrieve`: must now return data-flow and requirement hits.

</code_context>

<specifics>

## Specific Ideas
- No specific requirements — open to standard approaches for the dual-path SQL and dual-engine graph implementations.

</specifics>

<deferred>

## Deferred Ideas
- Mermaid diagram generation — skip unless asked.
- Semantic search / embeddings — keep ctx's YAGNI stance.
- cobi's legacy `cli.py`, `search/`, `docs/` — dead weight, don't port.
- cobi's `data_flows` table (never written) — don't port.

</deferred>

---

*Phase: 04-Merge — Data-Flow & Multi-Language Indexing*
*Context gathered: 2026-08-10*
