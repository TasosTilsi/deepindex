---
phase: 1
name: Foundation — Graph + Fingerprint + Cache
status: nyquist-compliant
date: 2026-07-25
---

# Phase 1 Validation: Foundation

## Test Infrastructure

| Component | Value |
|-----------|-------|
| Framework | vitest 2.1.9 |
| Config | `vitest.config.ts` (root) |
| Command | `pnpm test` |
| Test dirs | `tests/` |
| Test files | 3 (graph, cache, fingerprint) |
| Total tests | 24 (was 21, +3 from validation pass) |
| Pass rate | 100% |

## Per-Requirement Coverage

| REQ | Status | Test File | Test Name(s) | Notes |
|-----|--------|-----------|--------------|-------|
| GRPH-01 | COVERED | `tests/graph.test.ts` | `parses all 3 fixture files`, `extracts 4 exported symbols` | tree-sitter WASM parser populates files/symbols/imports/edges |
| GRPH-02 | COVERED | `tests/graph.test.ts` | `rebuild on unchanged files is a no-op`, `rebuild after one file change re-parses only that file` | hash-based invalidation: skipped files keep hash+parsed_at; changed file updates hash only |
| GRPH-03 | COVERED | `tests/graph.test.ts` | `detects broken import (c.ts imports ./missing)` | unresolved imports marked `resolved=0` in DB |
| GRPH-04 | COVERED | `tests/graph.test.ts` | `BFS: foo depends on bar (depth 1)`, `BFS: foo transitively reaches baz (depth 2)`, `BFS: bar is a dependent of foo`, `BFS: baz has dependent bar` | iterative SQL BFS, both directions, multi-depth |
| FNGR-01 | COVERED | `tests/fingerprint.test.ts` | `hash is sha256 of content`, `size matches byte length`, `updatedAt is parseable ISO date`, `version defaults to 1, can be overridden` | all 5 fields of {hash, version, confidence, size, updatedAt} verified |
| FNGR-02 | COVERED | `tests/fingerprint.test.ts` | `confidence = 1 with all-default signals`, `confidence = 0 with all-zero signals`, `confidence = 0.7 with mixed signals` | weighted formula 0.4*hashStable + 0.3*importsResolved + 0.3*testsPass |
| CACH-01 | COVERED | `tests/cache.test.ts` | `set + get round-trips content and fingerprint`, `re-storing same content returns same version + hash (no-op)`, `re-storing mutated content yields new hash, version 2`, `delete removes entry` | hash-keyed store, version monotonic, get bumps last_access |
| CACH-02 | COVERED | `tests/cache.test.ts` | `LRU eviction when capacity exceeded`, `eviction emits a log line to stdout` | 100MB default cap, oldest-by-last_access evicted, log line asserted |

## Per-Task Map

| Task | Description | Test Coverage |
|------|-------------|---------------|
| 1.1 | Init + CLI scaffold | manual: `ctx --version` exits 0 |
| 1.2 | SQLite schema | covered transitively (all graph tests assume schema) |
| 1.3 | File walker | covered transitively (all graph tests walk fixture) |
| 1.4 | tree-sitter parser | GRPH-01 |
| 1.5 | Import resolver | GRPH-03 |
| 1.6 | Graph builder (two-pass) | GRPH-01, GRPH-02 |
| 1.7 | BFS queries | GRPH-04 |
| 1.8 | Fingerprint | FNGR-01, FNGR-02 |
| 1.9 | Context cache | CACH-01, CACH-02 |
| 1.10 | `ctx build` CLI | manual smoke (`ctx build`, `ctx status`) |
| 1.11 | Tests + fixture | all above |

## Manual-Only

None. All phase 1 requirements have automated verification.

## Validation Audit 2026-07-25

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |

**Gaps identified and filled**:
1. **GRPH-02** (hash-skip rebuild) was previously verified only via ad-hoc CLI run, not automated. Added `rebuild on unchanged files is a no-op` + `rebuild after one file change re-parses only that file` tests.
2. **CACH-02** (eviction logged, never silent) was observed in stdout but never asserted. Added `eviction emits a log line to stdout` test that captures `console.log` and asserts the eviction message.

## Sign-Off

Phase 1 is Nyquist-compliant: all 8 requirements have automated tests that run green via `pnpm test`. Validation pass added 3 tests, growing the suite from 21 → 24, all passing in 600ms.
