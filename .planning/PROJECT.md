# Project: DeepIndex

## What This Is

DeepIndex is a self-healing, token-efficient context engineering framework for AI coding harnesses. It manages repository context as persistent state with its own lifecycle, so the LLM is only invoked when deterministic health signals drop below threshold.

**v2 (in planning):** DeepIndex absorbs the capabilities of two prior projects — cobi-tool (codebase indexing: multi-language symbols, SQL/data-flow analysis, impact analysis, requirements traceability) and Recall (git-history → LLM → knowledge graph: typed entities with backlinks, MCP server, Claude hooks). The merged project keeps the DeepIndex identity and TypeScript stack; cobi and Recall are reference implementations whose ideas port to TS.

Target users: developers using Claude Code, Codex CLI, Cursor, Gemini CLI, Aider, OpenHands, or any other CLI harness that benefits from pre-assembled, validated context.

## Core Value

Reduce LLM token burn by moving context engineering outside the model. The framework builds, observes, evaluates, repairs, and assembles context deterministically. The LLM is one component in the pipeline, not the component that solves every problem.

**v2 adds:** structure intelligence (how data moves through the code) and memory (why the code became this way over time) to the live-snapshot context engine. All of it runs without an LLM — summarization and extraction are optional, configurable enrichment.

## Why Now

Most agents treat context as a disposable prompt. The shift to context-as-OS is the next platform shift in AI coding tools. Winners will manage context as persistent state with incremental builds, dependency graphs, caching, invalidation, health checks, and event-driven updates.

## How It Works

```
User
  ↓
Task Orchestrator
  ↓
┌─────────────┴─────────────┐
↓                           ↓
Context Engine        Repository Index
  ↓                           ↓
└─────────────┬─────────────┘
              ↓
      Health Evaluator
              ↓
  healthy?   ↓   no
   yes  ───→ LLM ←── Repair Engine
```

The LLM is never responsible for maintaining context. The framework is.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript over Python | Strong typing for graph/parser, better tree-sitter bindings, native ESM, broad harness compatibility | — Pending |
| SQLite via better-sqlite3 | Sync API, zero-config, single file, no daemon | — Pending |
| tree-sitter for TS/JS/Python | Fast, incremental, multi-language, no LLM | — Pending |
| Generic OpenAI-compatible client | Works with OpenAI, Anthropic-via-proxy, Ollama, llama.cpp, LM Studio | — Pending |
| Hash-based invalidation | Deterministic regen trigger, no fuzzy checks | — Pending |
| Event-driven updates via chokidar | Cost near zero during normal use | — Pending |
| Deterministic-first repair | Compiler, linter, tests, graph traversal before any LLM | — Pending |
| Lazy: skip embeddings until proven needed | Cuts vector DB dep, 95% of retrieval covered by keyword + graph | — Pending |
| Lazy: skip web UI | CLI first, UI only after MVP validated | — Pending |
| Lazy: skip multi-language beyond py/ts/js | tree-sitter supports more, defer until asked | — Pending |
| **Merge home = this repo** | DeepIndex is the idea; cobi/Recall capabilities absorbed, not separate products | — Locked 2026-08-09 |
| **Merge stack = TypeScript** | cobi + Recall are Python references; port ideas, not code | — Locked 2026-08-09 |
| **cobi = code indexing, not only data** | Absorb full indexing: multi-language symbols, complexity, data-flow, graph, impact, requirements | — Locked 2026-08-09 |
| **Discuss before implement** | Merge is milestone-scale; decisions locked before any code | — Locked 2026-08-09 |
| **One unified SQLite store** | One `.db` (schema v3), three indexers: symbol/import graph, data-flow graph, temporal KG. User: single database. | — Locked 2026-08-09 (04-CONTEXT D-05) |
| **LLM optional** | All retrieval/indexing deterministic and LLM-free by default; LLM summarization/extraction is configurable enrichment, never required. User: "context retrieved without LLMs". | — Locked 2026-08-09 (04-CONTEXT D-06) |
| **Reuse ctx OpenAI-compatible client for LLM extraction** | Recall's git-history LLM extraction maps to existing repair client; used only when LLM extraction enabled | — Proposed (05-CONTEXT D-09) |
| **Fix Recall's dead backlinks** | Recall schema has inverse trigger but pipeline never writes backlinks; port + fix | — Proposed (05-CONTEXT D-11) |
| **MCP server via official SDK** | 6 read-only tools mirroring Recall; stdio, stderr-only | — Proposed (06-CONTEXT D-07) |
| **UI stays deferred** | Recall's React/Sigma.js is reference, not ported; ctx YAGNI holds | — Proposed (06-CONTEXT D-10) |

## Out of Scope

- Embeddings / vector search (YAGNI — keyword + graph BFS first)
- Web UI / dashboard (CLI first; Recall's UI is reference, not ported)
- Webhook integrations (git hooks are enough)
- Cloud sync / multi-machine coordination
- Auto-fixing code (the harness's job, not this framework's)
- Replacing the LLM (we orchestrate, we don't substitute)
- Mermaid diagram generation (cobi's is mostly placeholder)
- Recall v3.2 extras: RAG chat, hierarchical synthesis, world map
- cobi/Recall legacy code: cobi `cli.py`/`search/`, Recall graphiti/queue/retention

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

---
*Last updated: 2026-07-25 after initialization*
