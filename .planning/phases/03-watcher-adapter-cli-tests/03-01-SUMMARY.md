---
phase: 03-watcher-adapter-cli-tests
plan: 01
title: "Watcher + Adapter + CLI + Tests"
subsystem: process-boundary
tags: [watcher, adapter, serve, cli, tests, chokidar]
dependency_graph:
  requires: [phase-2-health-retrieve-repair-reflect]
  provides: [WTCH-01..03, ADPT-01, CMD-01..06, TEST-01..03]
  affects: [phase-4-merge-dataflow-multilang]
tech-stack:
  added: [chokidar]
  patterns: [cache invalidation, pure-function adapter, node:http server, commander CLI]
key-files:
  created:
    - src/watcher.ts
    - src/adapter-claude-code.ts
    - src/serve.ts
    - tests/watcher.test.ts
    - tests/adapter.test.ts
    - tests/cli.test.ts
    - tests/smoke.test.ts
  modified:
    - src/cli.ts
    - src/index.ts
    - src/graph/build.ts
    - package.json
    - vitest.config.ts
---

## Objective

Surface the framework as a usable CLI harness: chokidar-based watcher
(invalidate affected summary cache on change, no auto-repair), pure-function
`adaptClaudeCode` module (same JSON shape as serve endpoint), `node:http`
server exposing `POST /context` on port 7331, commander CLI extended with
`repair`/`serve`/`watch`/`retrieve` (keeping `build`/`status`), and a vitest
suite covering the new modules, the six CLI verbs, and a smoke run against
`fixtures/sample-repo`.

## What Was Built

- **Watcher** (`src/watcher.ts`) — chokidar watches a repo; on file change
  calls `cacheDelete(db, 'summary:'+sha256(absPath))` so the affected summary
  regenerates on next access. No auto-repair (D-04). Clean SIGINT exit.
- **Adapter** (`src/adapter-claude-code.ts`) — pure function returning the
  same JSON shape as the serve endpoint; no I/O, no singletons.
- **Serve** (`src/serve.ts`) — `node:http` server, `POST /context` on port
  7331, returns retrieval payload.
- **CLI** (`src/cli.ts`) — commander verbs: `build`, `status`, `repair`,
  `retrieve`, `serve`, `watch`. Absolute-path resolution for watch.
- **Tests** — `tests/watcher.test.ts` (3), `tests/adapter.test.ts`,
  `tests/cli.test.ts` (spawns CLI, asserts `invalidated: f.ts`, SIGTERM
  exit 0), `tests/smoke.test.ts` (plain tsx script, excluded from vitest).
- **Coverage gate** — `@vitest/coverage-v8` + vitest coverage block
  (provider v8, include `src/**/*.ts`, exclude `src/types.ts`, thresholds
  lines 70, enabled when `CI=1`).

## Verification

- `pnpm exec tsc --noEmit` — clean.
- `pnpm test` — 89 passed, 1 skipped (10 files).
- `CI=1 pnpm test` — coverage gate enforced (≥70% lines on `src/`).
- `pnpm run smoke` — end-to-end self-check on fixture repo, green.

## Deviations

- Watch CLI test fixed: absolute cli path + `onReady` signal (`watching`
  line) — relative path + cwd=watchDir caused `ERR_MODULE_NOT_FOUND`;
  500ms sleep raced chokidar.
- `tests/smoke.test.ts` is a plain tsx script (run via `pnpm run smoke`),
  excluded from vitest — not a test suite.

## Self-Check: PASSED
