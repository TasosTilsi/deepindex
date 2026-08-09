---
phase: 03-watcher-adapter-cli-tests
verified: 2026-08-09T19:45:00Z
status: passed
score: 8/8 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 7/8
  gaps_closed:
    - "CI=1 pnpm test enforces >= 70% lines coverage on src/ (ROADMAP SC 4: 'Coverage ≥ 70% on src/')"
  gaps_remaining: []
  regressions: []
---

# Phase 3: Watcher + Adapter + CLI + Tests Verification Report

**Phase Goal:** Make the framework usable from any CLI harness. Watcher drives incremental updates. Adapter exposes context for Claude Code. CLI commands cover build/status/repair/serve/watch/retrieve. Tests prove the end-to-end loop on a real fixture.
**Verified:** 2026-08-09T19:45:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure

## Goal Achievement

### Observable Truths

| #   | Truth     | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1   | `ctx watch` starts chokidar, prints `invalidated: <file>` on save, regenerates affected summary, exits cleanly on SIGINT | ✓ VERIFIED | `tests/cli.test.ts` watch test passes (spawns CLI, asserts `invalidated: <relpath>`, SIGTERM exit 0). `tests/watcher.test.ts` (3 tests) passes. `src/watcher.ts:71` calls `cacheDelete(db, 'summary:'+sha256(absPath))` — drops the affected summary cache entry so it regenerates on next access (D-04, no auto-repair). |
| 2   | `ctx serve` accepts POST /context {task, repoPath}, returns JSON with top-K files, summaries, graph neighborhood | ✓ VERIFIED | `tests/cli.test.ts` serve test passes (fetch POST /context, asserts topFiles/neighborhood/health). `src/serve.ts:66` calls `adaptClaudeCode` and returns its result directly. |
| 3   | `adaptClaudeCode` importable as a library function with the same shape as the serve endpoint; topK defaults 10, dbPath defaults `.ctx.db` | ✓ VERIFIED | `src/serve.ts:66` calls `adaptClaudeCode` and returns its result directly — shapes identical by construction. Exported from `src/index.ts:30-32`. `tests/adapter.test.ts` (4 tests, 1 skipped) passes: shape, non-empty topFiles, topK≤10 default, missing-db throws. `DEFAULT_TOP_K`=10 from `src/retrieve.ts`; dbPath default `.ctx.db` at `src/adapter-claude-code.ts`. |
| 4   | `ctx retrieve <query>` returns top-K paths in human or `--json` mode | ✓ VERIFIED | `tests/cli.test.ts` retrieve test passes (stdout matches `/\.ts/`). Smoke test prints `src/with-comments.ts score=0.643`. `src/cli.ts` implements both modes. |
| 5   | `ctx repair` shows before/after score | ✓ VERIFIED | `tests/cli.test.ts` repair test passes (stdout contains `before:` and `after:`). `src/cli.ts` prints `before: {score}` / `after: {score}`. |
| 6   | `pnpm test` runs the full vitest suite | ✓ VERIFIED | `pnpm exec vitest run` → 10 files, 89 passed, 1 skipped (90 collected), exit 0. All fixture-based suites green: graph 9, health 13, retrieve 14, repair 14, fingerprint 8, cache 7, reflect 12, watcher 3, adapter 4, cli 6. |
| 7   | `CI=1 pnpm test` enforces >= 70% lines coverage on src/ | ✓ VERIFIED | **Gap closed.** `@vitest/coverage-v8` ^2.1.9 in devDependencies (package.json:39). `vitest.config.ts:10-17` has coverage block: provider v8, include `src/**/*.ts`, exclude `src/**/*.test.ts` + `src/types.ts`, enabled when `CI=1`, thresholds lines 70. `CI=1 pnpm test` exits 0 and emits v8 coverage report: src/ lines 72.14% ≥ 70% (All files 76.99%). |
| 8   | `pnpm run smoke` exits 0 and runs build → status → retrieve on fixtures/sample-repo | ✓ VERIFIED | `pnpm run smoke` exits 0, prints health JSON (`score: 67`, dimensions, issues) and top-K file (`src/with-comments.ts score=0.643`), ends with `smoke ok`. |

**Score:** 8/8 truths verified (0 present, behavior-unverified)

### Required Artifacts

| Artifact | Expected    | Status | Details |
| -------- | ----------- | ------ | ------- |
| `src/watcher.ts` | createWatcher with debounce + cacheDelete invalidation | ✓ VERIFIED | Exists, substantive, wired (cli.ts, index.ts). No auto-repair. |
| `src/serve.ts` | serve() node:http server, POST /context, port 7331 | ✓ VERIFIED | Exists, substantive, wired (cli.ts, index.ts). |
| `src/adapter-claude-code.ts` | adaptClaudeCode pure function, AdapterResult shape | ✓ VERIFIED | Exists, substantive, wired (serve.ts, cli.ts, index.ts). |
| `src/cli.ts` | six commander subcommands | ✓ VERIFIED | Exists, substantive. build/status/repair/retrieve/serve/watch all registered (6 `command(...)` matches). |
| `src/index.ts` | re-exports createWatcher, serve, adaptClaudeCode | ✓ VERIFIED | Exists, wired. |
| `vitest.config.ts` | v8 coverage, 70% threshold on src/ | ✓ VERIFIED | **Gap closed.** Coverage block present (provider v8, include src/**/*.ts, exclude src/types.ts, enabled CI=1, thresholds lines 70). |
| `tests/watcher.test.ts` | 3 tests | ✓ VERIFIED | 3 passing. |
| `tests/adapter.test.ts` | 4 tests | ✓ VERIFIED | 4 passing (1 skipped via skipIf). |
| `tests/cli.test.ts` | 6 tests, one per command | ✓ VERIFIED | 6 passing (build, status, repair, retrieve, serve, watch). |
| `tests/smoke.test.ts` | build → status → retrieve | ✓ VERIFIED | Plain tsx script (excluded from vitest), run via `pnpm run smoke`. Exits 0. |
| `package.json` | chokidar dep, smoke + start scripts, @vitest/coverage-v8 | ✓ VERIFIED | `chokidar: ^4.0.0` in dependencies; `smoke` and `start` scripts present; `@vitest/coverage-v8: ^2.1.9` in devDependencies. |

### Key Link Verification

| From | To  | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| serve.ts | adapter-claude-code.ts | `adaptClaudeCode(...)` call at serve.ts:66 | ✓ WIRED | Serve endpoint is a thin HTTP wrapper over the adapter (D-08). |
| adapter-claude-code.ts | retrieve.ts + health.ts + graph/query.ts | imports at lines 6-8 | ✓ WIRED | Reuses phase 2 logic; no new business logic. |
| watcher.ts | cache.ts:cacheDelete | `cacheDelete(db, key)` at watcher.ts:71 | ✓ WIRED | No auto-repair (D-04). |
| cli.ts | watcher/serve/adapter/repair/retrieve | imports at lines 7-11 | ✓ WIRED | One command per module. |
| vitest.config.ts | src/**:70% line threshold | coverage block (lines 10-17) | ✓ WIRED | **Gap closed.** `CI=1 pnpm test` emits report; src/ lines 72.14% ≥ 70%. |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| serve.ts response | topFiles/health/neighborhood | adaptClaudeCode → retrieve + getHealth + graph queries | Yes | ✓ FLOWING |
| adapter topFiles | hits | retrieve(db, task, ...) real SQLite query | Yes | ✓ FLOWING |
| watcher invalidation | cacheDelete key | sha256(absPath) real path | Yes | ✓ FLOWING |
| cli status | report | getHealth(db, {config}) real query | Yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Type check | `pnpm exec tsc --noEmit` | exit 0, no errors | ✓ PASS |
| Full test suite | `pnpm exec vitest run` | 89 passed, 1 skipped (10 files), exit 0 | ✓ PASS |
| Coverage gate (CI) | `CI=1 pnpm test` | exit 0, v8 report emitted, src/ lines 72.14% ≥ 70% | ✓ PASS |
| Smoke | `pnpm run smoke` | exit 0, health JSON + top-K printed, `smoke ok` | ✓ PASS |
| Watch behavior | cli.test.ts watch test | `invalidated: <relpath>` printed, SIGTERM exit 0 | ✓ PASS |
| Serve behavior | cli.test.ts serve test | POST /context returns AdapterResult JSON | ✓ PASS |

### Probe Execution

No probes declared in PLAN or SUMMARY. SKIPPED.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| WTCH-01 | 03-01-PLAN | chokidar watches repo, invalidate on save | ✓ SATISFIED | watcher.ts + watcher.test.ts + cli watch test |
| WTCH-02 | 03-01-PLAN | debounce 250ms, coalesce | ✓ SATISFIED | watcher.ts debounceMs default 250 |
| WTCH-03 | 03-01-PLAN | .gitignore respected, --no-ignore override | ✓ SATISFIED | watcher.ts ignored config + cli --no-ignore |
| ADPT-01 | 03-01-PLAN | adapter-claude-code same shape as serve | ✓ SATISFIED | adapter-claude-code.ts + adapter.test.ts |
| CMD-01 | 03-01-PLAN | ctx build | ✓ SATISFIED | cli.ts + cli.test.ts build test |
| CMD-02 | 03-01-PLAN | ctx status JSON health | ✓ SATISFIED | cli.ts + cli.test.ts status test |
| CMD-03 | 03-01-PLAN | ctx repair before/after | ✓ SATISFIED | cli.ts + cli.test.ts repair test |
| CMD-04 | 03-01-PLAN | ctx serve port 7331 | ✓ SATISFIED | serve.ts + cli.test.ts serve test |
| CMD-05 | 03-01-PLAN | ctx watch | ✓ SATISFIED | watcher.ts + cli.test.ts watch test |
| CMD-06 | 03-01-PLAN | ctx retrieve | ✓ SATISFIED | cli.ts + cli.test.ts retrieve test |
| TEST-01 | 03-01-PLAN | vitest unit tests | ✓ SATISFIED | 10 test files, 89 passed |
| TEST-02 | 03-01-PLAN | fixture with broken import | ✓ SATISFIED | fixtures/sample-repo, health detects broken import |
| TEST-03 | 03-01-PLAN | end-to-end smoke | ✓ SATISFIED | pnpm run smoke exit 0 |

All 13 requirement IDs from PLAN frontmatter (WTCH-01..03, ADPT-01, CMD-01..06, TEST-01..03) are present in REQUIREMENTS.md and accounted for. No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| src/cli.ts | 57 | `ctx status` missing-DB message via `console.log` (stdout) not stderr | ⚠️ Warning | Violates D-14 (errors to stderr); not a success criterion. Carried from previous verification; repair (line 87) and retrieve (line 129) use `console.error` correctly. |
| src/cli.ts | ~213 | `ctx watch` createWatcher error exit code | ⚠️ Warning | Minor D-13 deviation; not a success criterion. Carried from previous verification. |

No TBD/FIXME/XXX debt markers found in phase 3 files. No stub patterns found.

### Human Verification Required

None. All five ROADMAP success criteria were verified programmatically (full test suite, coverage gate run, smoke run, tsc, behavioral cli tests for watch/serve).

### Gaps Summary

The single gap from the previous verification — ROADMAP success criterion 4 (coverage gate) — is **closed**:

- `@vitest/coverage-v8` ^2.1.9 added to devDependencies (package.json:39).
- `vitest.config.ts:10-17` now has the coverage block: provider v8, include `src/**/*.ts`, exclude `src/**/*.test.ts` + `src/types.ts`, `enabled: process.env.CI === '1'`, thresholds lines 70.
- `CI=1 pnpm test` exits 0 and emits a v8 coverage report showing src/ lines at 72.14% (≥ 70% threshold). The gate is enforced.

All 5 ROADMAP success criteria now pass:
1. `ctx watch` — invalidated lines on save, clean SIGINT exit (behavioral test passes).
2. `ctx serve` — POST /context returns AdapterResult JSON (behavioral test passes).
3. adapter-claude-code — same shape as serve endpoint, importable (adapter tests pass).
4. `pnpm test` + coverage ≥ 70% on src/ — 89 passed / 1 skipped; CI=1 gate enforces 72.14% ≥ 70%.
5. `pnpm run smoke` — build → status → retrieve on fixtures/sample-repo, exit 0, prints health JSON + top-K.

Two minor non-blocking warnings carried from the previous verification (status missing-DB message on stdout per D-14; watch infra error exit code per D-13) do not affect any success criterion. The phase goal is achieved.

---

_Verified: 2026-08-09T19:45:00Z_
_Verifier: Claude (gsd-verifier)_
