---
phase: 260809-mm4-fix-phase-3-loose-ends
plan: 01
status: complete
subsystem: testing
tags: [tsc, strict-mode, smoke-test, phase-3]
date: 2026-08-09
---

# Summary: Fix phase-3 loose ends

Closed the two phase-3 loose ends tracked in STATE.md: `tsc --noEmit` strict-mode errors and the missing smoke test.

## What was done

1. **tsc strict-mode errors fixed** (3 files):
   - `src/cli.ts` — repair loop: `for (const [i, s] of result.stages.entries())` replaces indexed `result.stages[i]` access (`noUncheckedIndexedAccess`).
   - `src/health.ts` — `loadConfig`: `sectionMatch[1] ?? ''` and `valueMatch[1] ?? ''` guards; empty string flows through existing no-match/throw paths, preserving the throw-on-non-numeric contract.
   - `src/repair.ts` — **4th error found during verify** (not in plan): `buildLLMPrompt` param typed as `HealthReport` instead of inline `{ dimensions: Record<string, number> }` — `HealthDims` lacks an index signature, so it was not assignable.

2. **`tests/smoke.test.ts` created** — plain tsx script (not vitest), reusing the spawn-tsx-absolute-bin pattern from `tests/cli.test.ts`. Runs build → status → retrieve "auth" on `fixtures/sample-repo` with a temp DB, prints health JSON + top-K files, exits non-zero on any failure. Ends with `smoke ok`.

3. **`vitest.config.ts`** — excluded `tests/smoke.test.ts` from the vitest runner (its `include: ['tests/**/*.test.ts']` glob was picking up the script and failing with "No test suite found").

## Verify gate (all green)

- `pnpm exec tsc --noEmit` → exit 0
- `pnpm run smoke` → exit 0, prints health JSON + top-K files, `smoke ok`
- `pnpm test` → 10 files passed, 88 passed | 1 skipped

## Requirements covered

- CMD-03 (repair command tsc fix)
- TEST-01 (smoke test)

## Commits

- `6806f5c` fix(03): resolve tsc strict-mode errors
- `6a6c62d` test(03): add smoke test, exclude from vitest

## Notes

- Root cause of all tsc errors: `tsconfig.json` `noUncheckedIndexedAccess: true`. Flag not disabled.
- The `repair.ts` error was pre-existing but not in the plan's error list — surfaced by the verify gate, fixed in the same commit.
- Phase 3 is now cleanly closed: no loose ends remain in STATE.md.
