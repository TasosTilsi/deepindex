# DeepIndex

**Self-healing, token-efficient context engineering framework for AI coding harnesses.**

DeepIndex turns a repository into a queryable, self-repairing knowledge store. It indexes code into a SQLite-backed symbol/import graph, scores index health, retrieves relevant context for a task, and repairs degradation through a deterministic-then-LLM pipeline. It ships a `deepindex` CLI, a POST `/context` HTTP server, a chokidar-based cache-invalidation watcher, a pure-function adapter for Claude Code, an MCP server, Claude Code / Codex / OpenCode / DeepSeek Harness hooks, and a read-only web dashboard.

**Local-first. No SaaS. No API key required.** All indexing and retrieval is deterministic and LLM-free by default; LLM summarization/extraction is optional enrichment.

---

## Why DeepIndex?

AI coding agents are productive — but they work with a shallow understanding of the codebase. Every session re-derives what the code is, why it exists, and what changed. DeepIndex makes that knowledge **persistent, structured, and queryable**:

- **What the code is** — symbols, imports, data-flow, multi-language structure.
- **Why it exists** — git history distilled into typed entities (decisions, bug fixes, patterns, tech debt).
- **How healthy it is** — a health score that gates LLM calls and drives self-repair.

It is not a vector database or a RAG framework. It is the deterministic, local-first layer that gives an agent structured context about a codebase — without burning tokens re-discovering it.

---

## Capabilities

| Capability | Description |
|------------|-------------|
| **Symbol/import graph** | Tree-sitter parsing (32 languages: TS/JS/Python/Java/C/C++/Go/Rust/PHP/Ruby/C#/Swift/Kotlin/Scala/Bash/Dart/Lua/Elixir/ObjC/HTML/CSS/JSON/YAML/Markdown/Vue/Svelte/Perl/R/Haskell/Clojure/Erlang/Zig) into a SQLite graph of files, symbols, imports, edges. |
| **Data-flow analysis** | SQL/data-flow extraction (CREATE TABLE, queries, ORM, config mappings), Table↔Query↔Service projection, impact analysis, parallel-storage detection. |
| **Git-history knowledge graph** | Walk git history, extract typed entities (decision, bug_fix, pattern, tech_debt, concept, breaking_change, security_fix, workflow) with bidirectional backlinks + FTS5 search. |
| **Health scoring** | Deterministic health score (freshness/consistency/coverage/confidence) that gates LLM calls. |
| **Retrieval** | Hybrid ranking (TF-IDF + graph proximity) + FTS5 entity search. |
| **Repair** | 4-stage pipeline: rebuild → cache invalidate → git-history probe → optional LLM. |
| **Requirements traceability** | `@req` code annotations linked to requirements; coverage reports. |
| **MCP server** | 6 read-only tools over the merged store (stdio, stderr-only logging). |
| **Hooks** | Claude Code, Codex, OpenCode, DeepSeek Harness — session start sync, prompt injection, tool-use capture, session summary. |
| **Web dashboard** | Read-only React dashboard visualizing the whole index + knowledge graphs. |

---

## Features

- **Deterministic-first, LLM-optional** — all indexing/retrieval works with zero LLM calls; LLM is configurable enrichment only.
- **One database** — a single SQLite store (schema v5) holds the symbol graph, data-flow graph, and temporal knowledge graph.
- **Local-first** — no SaaS, no API key, no cloud. Runs entirely on your machine.
- **Multi-harness** — MCP + hooks for Claude Code, Codex, OpenCode, and DeepSeek Harness.
- **Self-healing** — health scoring + a repair pipeline that re-resolves imports, invalidates cache, probes git history, and (optionally) consults an LLM.
- **Token-efficient** — retrieval assembles minimal context; health gates LLM calls; cache avoids re-computation.

---

## Quick Start

```bash
# Install
npm install -g deepindex   # or: pnpm add -g deepindex

# Index a repository
deepindex index <repo>

# Retrieve context for a task
deepindex retrieve "how does auth work"

# Check index health
deepindex health <repo>

# Serve the dashboard + API
deepindex serve

# Index git history into the knowledge graph
deepindex git-index <repo>

# Search the knowledge graph
deepindex search "auth"

# Install into an AI harness (Claude Code, Codex, OpenCode, DeepSeek Harness)
deepindex install
```

---

## Documentation

- **[Usage](docs/USAGE.md)** — full CLI reference, harness integration, dashboard.
- **[Design](docs/DESIGN.md)** — architecture, data model, retrieval, repair, phases.
- **[ADRs](docs/adr/)** — architecture decision records.
- **[Planning](.planning/)** — GSD planning state (phases, plans, verification).

---

## Development

```bash
pnpm install
pnpm test          # vitest suite
pnpm build         # tsc typecheck + emit
pnpm smoke         # end-to-end self-check on the fixture repo
pnpm --dir dashboard build   # build the web dashboard
```

Verify gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test` (CI enables the ≥70% coverage gate).

---

## License

[MIT](LICENSE)
