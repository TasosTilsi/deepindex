# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

Read `AGENTS.md` for the full project context — purpose, architecture, key files, testing requirements, and common patterns. It is the canonical agent reference for this repo.

DeepIndex is a self-healing, token-efficient context engineering framework for AI coding harnesses. It indexes a repo into a SQLite knowledge store (symbol/import graph + data-flow graph + git-history knowledge graph), scores health, retrieves context, and repairs degradation. Deterministic-first, LLM-optional, local-first. Ships a `deepindex` CLI, MCP server, harness hooks, and a multi-project web dashboard.

## Development commands

- `pnpm run deepindex <verb>` — run the CLI in dev (e.g. `pnpm run deepindex index <repo>`, `pnpm run deepindex search "auth"`)
- `pnpm test` — full vitest suite
- `pnpm test:watch` — vitest watch mode
- `pnpm exec vitest run tests/<module>.test.ts` — single test file
- `pnpm build` — tsc typecheck + emit
- `pnpm smoke` — end-to-end self-check on the fixture repo
- `pnpm --dir dashboard build` — build the web dashboard
- Verify gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test` — all three green before commit

## Gotchas

- ESM-only, NodeNext — imports carry `.js` extension (`import { x } from './cache.js'`).
- `CI=1 pnpm test` enables the v8 coverage gate (≥70% lines on `src/`, excludes `src/types.ts`); plain `pnpm test` skips coverage.
- `tests/smoke.test.ts` is a plain tsx script (run via `pnpm run smoke`), excluded from vitest — not a test suite.
- Do not touch `.omc/`, `.planning/`, `.serena/`, `.claude/`, `.opencode/`, `.windsurf/`, `.scratch/` — tooling state, not source.
- `.tree-sitter/` holds the 32 grammar `.wasm` files — needed at runtime, committed. Do not remove.
- Default DB is `.deepindex.db`; config file is `.deepindex.toml`.
- `CI=1 pnpm test` may fail on a pnpm store-index issue; bypass with `pnpm --config.verify-deps-before-run=false exec vitest run`.
- Git tests build a fixture repo in a temp dir via `tests/helpers/git-fixture.ts` (a committed fixture can't carry a real `.git` history).
