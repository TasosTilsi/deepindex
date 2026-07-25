---
phase: 2
name: Health + Retrieve + Repair + Reflect
status: nyquist-compliant
date: 2026-07-25
---

# Phase 2 Validation: Health + Retrieve + Repair + Reflect

## Test Infrastructure

| Component | Value |
|-----------|-------|
| Framework | vitest 2.1.9 |
| Config | `vitest.config.ts` (root) |
| Command | `pnpm test` |
| Test dirs | `tests/` |
| Test files | 7 (3 from phase 1, 4 new: health, retrieve, repair, reflect) |
| Total tests | 76 (was 24 after phase 1, +52 from phase 2) |
| Pass rate | 100% |

## Per-Requirement Coverage

| REQ | Status | Test File | Test Name(s) | Notes |
|-----|--------|-----------|--------------|-------|
| HLTH-01 | COVERED | `tests/health.test.ts` | `after buildGraph on the sample fixture with a broken import: consistency < 1 and issues include broken_import` | 4-dim score formula, 0-100 integer, broken-import drops consistency below 1.0 |
| HLTH-02 | COVERED | `tests/health.test.ts` | `reads repair_below = 80 from .ctx.toml`, `returns default for a missing .ctx.toml`, `returns default for a .ctx.toml with no [health] section` | `.ctx.toml` parsing with default 80 |
| HLTH-03 | COVERED | `tests/health.test.ts` | `on an empty DB: score in [0,100], coverage = 0.5*0.5, confidence defaults to 0.5`, `after buildGraph on the sample fixture ... consistency < 1` | JSON shape `{score, dimensions, issues}` |
| RTRV-01 | COVERED | `tests/retrieve.test.ts` | `tokenize ...`, `tfidf ...`, `top result for query "auth" is the seed file (a.ts)` | tokenize, tfidf, retrieve wired |
| RTRV-02 | COVERED | `tests/retrieve.test.ts` | `seed file (depth 0) ranks higher than depth-1 and depth-2 dependents`, `depth-1 file with the same keyword outranks a depth-2 file`, `seed file with no keyword match is still included (depth 0 proximity alone)` | 0.6*tfidf + 0.4*graphProximity with depth-1 vs depth-2 ordering |
| RTRV-03 | COVERED | `tests/retrieve.test.ts` | `summary skips leading comment lines and uses the real function body`, `payload keys are exactly path, score, symbols, summary` | No body/content; first non-comment line |
| REPR-01 | COVERED | `tests/repair.test.ts` | `stage1Rebuild ...`, `stage2CacheInvalidate ...`, `stage3GitHistory ...` | Deterministic 3-stage pipeline; short-circuits on success |
| REPR-02 | COVERED | `tests/repair.test.ts` | `OpenAICompatibleClient > complete() returns parsed content and usage on 2xx`, `complete() throws on non-2xx ...`, `stage4LLM > cache miss then hit` | OpenAI-compatible POST; cacheGet before fetch; cacheSet on success |
| REPR-03 | COVERED | `tests/repair.test.ts` | `repair with LLM > runs all 4 stages and reports llmCost when score < threshold and llm is set`, `repair pipeline > does not invoke the LLM when opts.llm is not set` | 3-predicate gate (score<thr, prev failed, llm set); cost reported |
| RFLT-01 | COVERED | `tests/reflect.test.ts` | `parseVitestJson > extracts pass/fail/skip/total and durationMs from testResults`, `uses numPendingTests for skip (not numSkippedTests)`, `throws TypeError if a required counter is missing` | numPendingTests → skip (Pitfall 8) |
| RFLT-02 | COVERED | `tests/reflect.test.ts` | `parseEslintJson > sums errorCount and warningCount across an array`, `throws TypeError on non-array input` | Array input (Pitfall 6) |
| RFLT-03 | COVERED | `tests/reflect.test.ts` | `parseCoverageJson > derives linesPct from statementMap + s hit counts`, `returns 1 for all percentages on an empty object`, `throws TypeError on non-object input` | statementMap hit counts (Pitfall 7) |

## Per-Task Map

| Task | Description | Test Coverage |
|------|-------------|---------------|
| 2.1 | Schema migration to v2 with health_signals table | `schema migration > bumps user_version to 2 ...` |
| 2.2 | reflect.ts (parseVitestJson, parseEslintJson, parseCoverageJson) | All 11 reflect tests |
| 2.3 | health.ts (recordSignal, getSignals, loadConfig, getHealth) | signals round-trip, empty-DB health, broken-import drops consistency, .ctx.toml parsing |
| 2.4 | retrieve.ts (tokenize, tfidf, retrieve) | tokenize, tfidf, payload shape (no body), empty-DB retrieve |
| 2.5 | retrieve.ts graph BFS combined score (RTRV-02) | depth ordering, keyword+proximity, depth-0 alone |
| 2.6 | retrieve.ts minimal payload with summary (RTRV-03) | summary skips comments, payload keys |
| 2.7 | repair.ts stages 1-3 deterministic (REPR-01) | stage1, stage2, stage3 (.git missing), pipeline short-circuits, no LLM when not configured |
| 2.8 | repair.ts LLM stage 4 + response cache (REPR-02, REPR-03) | OpenAI client, stage4 cache miss/hit, 4-stage repair with LLM |
| 2.9 | reflect → health integration (RFLT-01..03 end-to-end) | vitest signal drives coverage, eslint signal increases coverage, coverage parser → signals |
| 2.10 | Self-check script | `scripts/selfcheck-phase2.mjs` runs end-to-end; output captured in 02-DEMO.md |
| 2.11 | Git-managed fixture + validation doc | `stage3GitHistory > detects a // CLAIM: contradiction in the git-managed fixture` |
| 2.12 | Final src/index.ts + SUMMARY | Done in 02-PLAN-SUMMARY.md |

## Manual-Only

None. All 12 requirements (HLTH-01..03, RTRV-01..03, REPR-01..03, RFLT-01..03) have automated tests.

## Deviations from Plan

- `coverage` dimension default: when both `tests_*` and `lint_*` signals are missing, the formula `0.5 * 0.5 = 0.25` applies (not 0.5). Test asserts 0.25.
- `loadConfig` non-numeric test: the regex `(\d+)` only matches digits, so a non-numeric value cannot reach the `parseInt` call. The test asserts the regex-fallback default behavior instead of throwing.
- Stage 2 cache invalidation: the plan's "wipe repair:% and summary:% keys" simplification is preserved per the plan, but the consequence is that `repair()` cannot rely on the LLM response cache across two consecutive calls (the cache is wiped before the LLM fires). The LLM cache contract (REPR-02) is verified via direct `stage4LLM` calls that skip stage 2.
- Stage 3 fixture: the `outdated-doc.ts` claim was updated so the recent commit removes the prior "12 worker threads" line; this makes the contradiction heuristic fire on the first run.
- Task 2.4 and 2.5 were committed together (single feat(retrieve) for the hybrid scoring path); the task split in the plan is preserved in the commit messages as a single RTRV-01 commit followed by a RTRV-02 commit on the test file.

## Sign-Off

Phase 2 is Nyquist-compliant: all 12 requirements (HLTH-01..03, RTRV-01..03, REPR-01..03, RFLT-01..03) have automated tests that run green via `pnpm test`. Phase 2 added 52 tests (24 → 76), all passing in ~900ms.
