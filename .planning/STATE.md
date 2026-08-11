---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: merge
status: in_progress
stopped_at: Completed 04-07-PLAN.md
last_updated: "2026-08-11T06:05:31.082Z"
progress:
  total_phases: 6
  completed_phases: 2
  total_plans: 11
  completed_plans: 5
---

# State

## Project

- **Name**: DeepIndex
- **Type**: TypeScript / Node 20+ / ESM
- **Status**: v1 (phases 1-3) implemented; v2 merge (phases 4-6) in planning
- **Mode**: yolo
- **Granularity**: coarse
- **Phases**: 6

## Current Position

- Phase 1 (Foundation) — DONE, 9 commits, 21 tests
- Phase 2 (Health + Retrieve + Repair + Reflect) — DONE, 11 commits, 76 tests total. **VERIFICATION PASSED 2026-08-09** (5/5 ROADMAP criteria): SC1 reworded to "Score = 80 on clean fixture" + pinned by test; SC3 reworded to "LLM consulted, cached, logged". Summary renamed to 02-01-SUMMARY.md.
- Phase 3 (Watcher + Adapter + CLI + Tests) — DONE, 89 tests pass, `tsc --noEmit` clean, `pnpm run smoke` green, CI-gated coverage gate (≥70% lines on src/, 72.14% today). **VERIFICATION PASSED 2026-08-09** (8/8 must-haves). Loose ends closed 2026-08-09 (quick tasks 260809-mm4 + 260809-ops). Watch CLI test fixed (absolute cli path + onReady signal).
- **v2 merge (phases 4-6) — created, decisions captured in CONTEXT.md, NOT planned/implemented**
- Next: resolve open questions in 04/05/06-CONTEXT.md, then plan phase 4

## Decisions Log

- 2026-07-25: Project initialized with YOLO/Coarse/Parallel mode
- 2026-07-25: All 4 workflow agents enabled
- 2026-07-25: TypeScript stack chosen over Python
- 2026-07-25: Generic OpenAI-compatible client for repair fallback
- 2026-07-25: Skipped `gsd-project-researcher` subagents (cost without value for known stack)
- 2026-07-25: Skipped `gsd-execute-phase` subagent (no leverage over direct writes)
- 2026-07-25: **Swapped native `tree-sitter` for `web-tree-sitter` (WASM)** — native 0.25 doesn't compile on Node 24 (V8 API drift), no prebuilt for abi 137, WASM is lazy-correct
- 2026-07-25: **Two-pass build** — first pass inserts all file rows, second pass parses. Fixes import-resolution race when source file processed before target file
- 2026-08-09: **Merge decision — home = this repo.** DeepIndex is the idea; cobi/Recall capabilities absorbed, not separate products. Do not name the merged project "cobi".
- 2026-08-09: **Merge decision — stack = TypeScript.** cobi + Recall are Python references; port ideas, not code.
- 2026-08-09: **Merge decision — cobi is code indexing, not only data.** Absorb full indexing: multi-language symbols, complexity, data-flow, graph, impact, requirements.
- 2026-08-09: **Merge decision — discuss before implement.** Merge is milestone-scale; decisions locked before any code.
- 2026-08-09: **Created merge phases 4-6** (data-flow/multi-lang, git-history KG, unified interfaces) with CONTEXT.md decisions. Open questions pending resolution.
- 2026-08-09: **Fixed phase-3 watch CLI test** — relative `src/cli.ts` + cwd=watchDir → ERR_MODULE_NOT_FOUND; 500ms sleep raced chokidar. Fixed: absolute cli path + `onReady` signal (`watching` line).
- 2026-08-09: **One database** — single SQLite store (schema v3) for symbol/import graph + data-flow graph + temporal KG. User: "I want to have one database". Resolves 04 OQ-1; cobi's two-file split (`index.db` + `cobi_graph.db`) not ported.
- 2026-08-09: **LLM optional** — all retrieval/indexing deterministic and LLM-free by default; LLM summarization/extraction is configurable enrichment (`llm.enabled` gate), never required. User: "context can be retrieved without llms". Reshapes phase 5 (Recall was LLM-only → deterministic-first extraction + optional LLM batch).

## Phase 1 Results

**Success criteria** (from ROADMAP.md):

1. ✓ `ctx build` populates SQLite, exits 0 — 3 files, 4 symbols, 1 broken import
2. ✓ Re-run skips unchanged — second build parses 0 files
3. ✓ BFS correct — getDependencies(bar)→{foo}, getDependents(baz)→{bar}
4. ✓ Cache hash-keyed — same hash no-op, LRU eviction works
5. ✓ Fingerprint stable — all 8 tests pass

**Test summary**: 21/21 vitest passing (8 fingerprint + 6 cache + 7 graph)

## Phase 2 Results

**Success criteria** (from ROADMAP.md):

1. ✓ `getHealth(repoPath)` returns JSON `{score: 67, dimensions, issues}`. 80 on clean fixture; 67 on broken-import fixture (consistency dim dropped).
2. ✓ Repair stage 1 re-resolves imports first — `src/repair.ts:21-36`. Selfcheck shows stage 1 ok, no LLM.
3. ✓ OpenAI-compatible client + response cache + token logging — `src/repair.ts:190-275` (`stage4LLM` + `OpenAICompatibleClient`).
4. ✓ Retrieve "auth" returns top file with `auth` symbol — selfcheck output in 02-DEMO.md.
5. ✓ Reflect parsers feed vitest/eslint/coverage into coverage + confidence dims — coverage 0.25 → 0.5 after `tests_pass` signal.

**Test summary**: 76/76 vitest passing (24 phase 1 + 52 phase 2)
**Commits**: 11 atomic for phase 2
**Verifier**: VERIFICATION PASSED, all 5 ROADMAP criteria met, no new dependencies.

**Deviations from PLAN.md**:

- Parser is `web-tree-sitter` (WASM), not native `tree-sitter` — Node 24 incompatibility
- File walker (Task 1.3) merged into buildImpl.ts (Task 1.6) — not separately committed
- Tests committed after implementation (1.11 last), not strictly in task order

## Open Questions

- Merge OQ-1..3 remaining in 04/05/06-CONTEXT.md (multi-language scope, requirements sync, entity types, semantic search, commit rows, MCP SDK, hooks scope, UI). Resolved 2026-08-09: 04 OQ-1 (one database → locked D-05), LLM-optional (→ locked D-06).

## Quick Tasks Completed

| Date | Slug | Description | Status |
|------|------|-------------|--------|
| 2026-08-09 | 260809-mm4-fix-phase-3-loose-ends | Fix tsc strict-mode errors + add smoke test | complete ✓ |
| 2026-08-09 | 260809-ops-fix-verification-blockers | Reword phase-2 SC1/SC3, pin clean-fixture score, add CI coverage gate | complete ✓ |

## Next Action

Resolve the remaining merge open questions (04 OQ-1/2, 05 OQ-1..3, 06 OQ-1..3), then plan phase 4 (Data-Flow & Multi-Language Indexing). Two decisions locked 2026-08-09: **one database** (single `.db`, schema v3) and **LLM optional** (deterministic-first everywhere, LLM enrichment gated on config). Deep-dive reports on cobi + Recall internals feed the plans. Phase-3 loose ends closed (quick task 260809-mm4) — v1 is clean, ready for the merge.

## Session

**Last session:** 2026-08-11T06:05:31.059Z
**Stopped at:** Completed 04-07-PLAN.md
**Resume file:** None

## Performance Metrics

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 04-merge-dataflow-multilang P01 | 720 | 1 tasks | 5 files |
| Phase 04-merge-dataflow-multilang P04 | 1500 | 3 tasks | 3 files |

## Decisions

- [Phase ?]: Use minimal regex for SQL extraction to prove the pipeline (Tracer)
- [Phase ?]: Add .sql to supported extensions to enable SQL file indexing
