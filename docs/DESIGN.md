# DeepIndex Design

## Overview

DeepIndex is a **context engineering framework** for AI coding harnesses. It turns a repository into a persistent, queryable, self-repairing knowledge store. The core idea: **deterministic-first, LLM-optional** — all indexing and retrieval works without an LLM; LLM is configurable enrichment only.

The system is built around a **single SQLite database** (schema v5) that holds three interlinked knowledge layers:

1. **Symbol/import graph** — what the code is.
2. **Data-flow graph** — how data moves through the code.
3. **Temporal knowledge graph** — why the code is the way it is (from git history).

---

## Architecture

```
                    ┌─────────────────────────────────────────────┐
                    │              deepindex CLI                  │
                    │  index · retrieve · health · repair · serve  │
                    │  git-index · search · mcp · install · watch  │
                    └───────────────┬─────────────────────────────┘
                                    │
        ┌───────────────┬───────────┴───────────┬────────────────┐
        │               │                       │                │
   ┌────▼────┐    ┌─────▼─────┐          ┌──────▼─────┐    ┌─────▼─────┐
   │  Graph  │    │  Health   │          │  Retrieve  │    │  Repair   │
   │  build  │    │  scoring  │          │  (hybrid)  │    │  (4-stage)│
   └────┬────┘    └─────┬─────┘          └──────┬─────┘    └─────┬─────┘
        │               │                      │                │
        └───────────────┴──────────┬───────────┴────────────────┘
                                   │
                          ┌────────▼────────┐
                          │   SQLite (v5)   │
                          │  one .db store  │
                          └─────────────────┘
```

### Interfaces

| Interface | Description |
|-----------|-------------|
| **CLI** | `deepindex` — all verbs (index, retrieve, health, repair, serve, watch, git-index, git-sync, search, mcp, install, data-flow, requirements). |
| **HTTP server** | `deepindex serve` — POST `/context` (adapter), GET `/api/*` (dashboard), GET `/` (dashboard static). |
| **Adapter** | Pure-function `adaptClaudeCode` — returns merged context (symbols + data-flow + entities). |
| **MCP server** | 6 read-only tools over the merged store (stdio, stderr-only logging). |
| **Hooks** | Claude Code, Codex, OpenCode, DeepSeek Harness — session lifecycle integration. |
| **Dashboard** | React + Vite read-only web dashboard (5 views). |

---

## Data Model (SQLite schema v5)

### Symbol/import graph
- **`files`** — repo-relative path (unique), sha256 hash, mtime, size, language.
- **`symbols`** — name, kind, start/end line, exported, complexity, `file_id` FK.
- **`imports`** — source, resolved flag, `resolved_file_id` FK.
- **`edges`** — `from_symbol_id` → `to_symbol_id`, kind (imports/calls/extends).
- **`requirement_code_links`** — `symbol_id` ↔ `req_id` (from `@req` annotations).

### Data-flow
- **`sql_queries`** — query text, `file_id` FK.
- **`query_tables`** — `query_id` ↔ `table_name`.

### Temporal knowledge graph
- **`commits`** — sha, message, author, dates, insertions/deletions, parent, `commit_type`.
- **`commit_files`** — `commit_sha` ↔ `file_id` (links temporal KG to symbol graph).
- **`entities`** — id (UUID5), type (8 types), name, content, `commit_sha`, created/last_seen.
- **`entity_symbols`** — `entity_id` ↔ `symbol_id` (entity↔code linkage).
- **`backlinks`** — `from_id` → `to_id`, typed relationship, context.
- **`metadata`** — key/value (e.g. `last_indexed_sha` cursor).
- **`entities_fts`** — FTS5 external-content table over entity name+content.

### Other
- **`cache`** — hash-keyed context store with LRU eviction.
- **`health_signals`** — key/value signals feeding the health score.

---

## Retrieval

Retrieval is **hybrid**: `0.6 * TF-IDF + 0.4 * graph proximity`.

1. **Seed symbols** — exact match + `LIKE` substring on query tokens.
2. **Graph BFS** — depth-1 + depth-2 dependents, bucketed by depth.
3. **TF-IDF** — over file path tokens + exported symbol names (smoothed IDF).
4. **Rank** — combine TF-IDF with graph proximity (deeper = lower proximity).

Entity search uses **FTS5** (`searchEntities`) with query sanitization (`ftsQuery`) so user queries never break MATCH syntax.

---

## Health & Repair

### Health score
Deterministic score (0–100) from four dimensions:
- **Freshness** — how current the index is.
- **Consistency** — import resolution, broken imports.
- **Coverage** — how much of the repo is indexed.
- **Confidence** — test/lint/coverage signals.

The score gates LLM calls: below a threshold, repair runs.

### Repair pipeline (4 stages)
1. **Rebuild** — re-parse changed files.
2. **Cache invalidate** — wipe stale summary/repair cache.
3. **Git-history probe** — detect contradictions via git history.
4. **LLM** (optional) — OpenAI-compatible client, response-cached, token-logged.

---

## Git-History Knowledge Graph

- **Git walker** — `child_process` + `git log`/`git diff`, oldest-first, skips merges, diff cap 4000 chars.
- **Extraction** — deterministic heuristics by default (type by keyword, name from subject); LLM batch extraction optional (10 commits/call).
- **Entity types** — `decision`, `bug_fix`, `pattern`, `tech_debt`, `concept`, `breaking_change`, `security_fix`, `workflow`.
- **Dedup** — UUID5(`type:name`), accumulate (append content + update `last_seen`).
- **Backlinks** — typed relationships (`fixes`, `implements`, `depends_on`, `relates_to`, `breaks`), written bidirectionally.
- **Incremental sync** — `last_indexed_sha` cursor; auto-init; history-rewrite fallback.
- **Security** — diffs sanitized before any LLM call (`[REDACTED:type]`); raw diffs not persisted.

---

## Phases

The project was built in 7 GSD phases:

| Phase | Deliverable |
|-------|-------------|
| 1 | Foundation — graph, fingerprint, cache |
| 2 | Health + Retrieve + Repair + Reflect |
| 3 | Watcher + Adapter + CLI + Tests |
| 4 | Merge: Data-Flow & Multi-Language Indexing |
| 5 | Merge: Git-History Knowledge Graph |
| 6 | Merge: Unified Interfaces (MCP, hooks, CLI/HTTP) |
| 7 | UI Dashboard |

---

## Design Principles

- **Deterministic-first, LLM-optional** — no LLM required for any core path.
- **One database** — single SQLite store for all knowledge layers.
- **Local-first** — no SaaS, no API key, no cloud.
- **Token-efficient** — minimal context, health-gated LLM, cached responses.
- **Reuse before rebuild** — reuse existing deps (better-sqlite3, web-tree-sitter, zod) before adding new ones.
