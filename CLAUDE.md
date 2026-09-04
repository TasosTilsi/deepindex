# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

Read `AGENTS.md` for the full project context — purpose, architecture, key files, testing requirements, and common patterns. It is the canonical agent reference for this repo.

## Development commands

- `pnpm run ctx <verb>` — run the CLI in dev (e.g. `pnpm run ctx build <repo>`, `pnpm run ctx status`)
- `pnpm test` — full vitest suite
- `pnpm test:watch` — vitest watch mode
- `pnpm exec vitest run tests/<module>.test.ts` — single test file
- `pnpm build` — tsc typecheck + emit
- `pnpm smoke` — end-to-end self-check on the fixture repo
- Verify gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test` — all three green before commit

## Gotchas

- ESM-only, NodeNext — imports carry `.js` extension (`import { x } from './cache.js'`).
- `CI=1 pnpm test` enables the v8 coverage gate (≥70% lines on `src/`, excludes `src/types.ts`); plain `pnpm test` skips coverage.
- `tests/smoke.test.ts` is a plain tsx script (run via `pnpm run smoke`), excluded from vitest — not a test suite.
- Do not touch `.omc/`, `.planning/`, `.tree-sitter/`, `.serena/`, `.claude/` — tooling state, not source.
