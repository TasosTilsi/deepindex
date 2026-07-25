# Project: ContextKit

## What This Is

ContextKit is a self-healing, token-efficient context engineering framework for AI coding harnesses. It manages repository context as persistent state with its own lifecycle, so the LLM is only invoked when deterministic health signals drop below threshold.

Target users: developers using Claude Code, Codex CLI, Cursor, Gemini CLI, Aider, OpenHands, or any other CLI harness that benefits from pre-assembled, validated context.

## Core Value

Reduce LLM token burn by moving context engineering outside the model. The framework builds, observes, evaluates, repairs, and assembles context deterministically. The LLM is one component in the pipeline, not the component that solves every problem.

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

## Out of Scope

- Embeddings / vector search (YAGNI — keyword + graph BFS first)
- Web UI / dashboard (CLI first)
- Multi-language beyond py/ts/js (tree-sitter supports more, defer)
- Webhook integrations (git hooks are enough)
- Cloud sync / multi-machine coordination
- Auto-fixing code (the harness's job, not this framework's)
- Replacing the LLM (we orchestrate, we don't substitute)

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
