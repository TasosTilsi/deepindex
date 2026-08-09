---
phase: 260809-ops-fix-verification-blockers-from-phases-2-
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/ROADMAP.md
  - .planning/STATE.md
  - tests/health.test.ts
  - package.json
  - vitest.config.ts
autonomous: false
requirements:
  - HLTH-01
  - REPR-03
  - TEST-02
user_setup: []

estimate:
  tokens: 30000
  raw_tokens: 15000
  tasks: 4
  confidence: med

must_haves:
  truths:
    - "ROADMAP phase-2 SC1 reads 'Score = 80 on a clean fixture' and SC3 no longer claims the LLM call restores health"
    - "tests/health.test.ts asserts a clean fixture (no broken imports, no signals) scores exactly 80"
    - "CI=1 pnpm test emits a v8 coverage report and enforces >= 70% lines on src/"
    - "pnpm test without CI stays green and does not run coverage"
  artifacts:
    - .planning/ROADMAP.md (reworded SC1/SC3)
    - .planning/STATE.md (corrected clean-fixture claim)
    - tests/health.test.ts (clean-fixture score test)
    - package.json (@vitest/coverage-v8 devDependency)
    - vitest.config.ts (coverage block)
  key_links:
    - "coverage.enabled: process.env.CI === '1' gates the gate — CI=1 enforces, local runs skip"
    - "clean-fixture score math: 0.3*1 + 0.3*1 + 0.2*0.25 + 0.2*0.75 = 0.8 -> score 80"
---

<objective>
Close the three verification blockers from phases 2 and 3: reword two ROADMAP success criteria that contradict documented behavior, pin the real clean-fixture score with a test, and implement the CI-gated coverage gate.

Purpose: The phase-2 and phase-3 verifiers flagged criteria that the code cannot satisfy as written. Two are wording fixes (the health formula is intentionally conservative; repair() intentionally never applies the LLM fix). One is a real missing feature (the coverage gate). All three must be resolved so the next verification pass is clean.

Output: Reworded ROADMAP/STATE, a clean-fixture score test, and a working CI=1 coverage gate.
</objective>

<execution_context>
@$HOME/.claude/gsd-core/workflows/execute-plan.md
@$HOME/.claude/gsd-core/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@.planning/phases/02-health-retrieve-repair-reflect/02-VERIFICATION.md
@.planning/phases/03-watcher-adapter-cli-tests/03-VERIFICATION.md

Ground truth (measured 2026-08-09):
- Clean fixture (no broken imports, no signals) scores 80, not 100: composite = 0.3*freshness(1.0) + 0.3*consistency(1.0) + 0.2*coverage(0.25) + 0.2*confidence(0.75) = 0.8. coverage defaults to 0.5*0.5 = 0.25 and confidence to 0.5*1.0 + 0.5*0.5 = 0.75 when no signals exist (src/health.ts:114-137). Score 100 requires all four test/lint signals present and healthy.
- repair() never applies the LLM fix and never re-checks health after stage 4 (src/repair.ts returns immediately after stage4LLM). Documented behavior — do not implement auto-apply.
- Current suite measures 72.14% lines on src/ (v8, excluding src/types.ts) — the 70% threshold is achievable with the existing 88-passing tests; do not add tests to inflate coverage and do not lower the threshold.
- vitest 2.1.9 supports `coverage.enabled` (CoverageV8Options.enabled). vitest does NOT auto-enable coverage from the CI env var — the explicit `enabled: process.env.CI === '1'` is required.
- tests/repair.test.ts has NO test asserting health restoration — no test update needed for SC3.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Reword ROADMAP phase-2 SC1 + SC3 and correct STATE.md clean-fixture claim</name>
  <files>.planning/ROADMAP.md, .planning/STATE.md</files>
  <action>
    Use Edit (scoped replacement), never Write, on both files. Do not touch any other phase's criteria.

    ROADMAP.md, Phase 2 Success Criteria #1 (line 42): replace the clause "Score = 100 on a clean fixture. Score drops on fixture with broken import." with "Score = 80 on a clean fixture. Score drops on fixture with broken import." Rationale: the composite formula caps at 0.8 on a signal-free clean fixture (coverage defaults to 0.25, confidence to 0.75). This is documented, intentional behavior — do NOT change the formula in src/health.ts.

    ROADMAP.md, Phase 2 Success Criteria #3 (line 44): delete the trailing clause that claims the LLM call restores health, so the criterion reads: "Repair path with deterministic failure: OpenAI-compatible client invoked, response cached, token count logged." Rationale: repair() caches the response and logs tokens but never applies the fix nor re-checks health after stage 4. Documented behavior — do NOT implement auto-apply.

    STATE.md, Phase 2 Results #1 (line 70): replace the claim "100 on clean fixture would hold" with "80 on clean fixture" (same root cause as SC1; the verifier flagged this claim as false). The line becomes: "1. ✓ `getHealth(repoPath)` returns JSON `{score: 67, dimensions, issues}`. 80 on clean fixture; 67 on broken-import fixture (consistency dim dropped)."
  </action>
  <verify>
    <automated>! grep -q "health restored" .planning/ROADMAP.md && grep -q "Score = 80 on a clean fixture" .planning/ROADMAP.md && grep -q "80 on clean fixture" .planning/STATE.md</automated>
  </verify>
  <done>
    ROADMAP phase-2 SC1 reads "Score = 80 on a clean fixture"; SC3 no longer contains the health-restoration clause; STATE.md phase-2 result #1 says "80 on clean fixture". No other ROADMAP criteria changed.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add clean-fixture score=80 test to tests/health.test.ts</name>
  <files>tests/health.test.ts</files>
  <action>
    Add one `it(...)` inside the existing `describe('getHealth', ...)` block (after the broken-import test at lines 74-86), following the same conventions: mkdtempSync + initDb + buildGraph + getHealth + rmSync cleanup. `mkdirSync` is already importable from 'node:fs' — add it to the existing import on line 2 if not present.

    Build a minimal clean fixture inline in the temp dir:
    - `const dir = mkdtempSync(join(tmpdir(), 'ctx-health-clean-'));`
    - create `join(dir, 'src')` with `mkdirSync(..., { recursive: true })`
    - write `src/a.ts` = `import { b } from './b';\nexport function a() { return b(); }\n`
    - write `src/b.ts` = `export function b() { return 1; }\n`
    - `const db = initDb(join(dir, 'test.db')); await buildGraph(db, dir); const r = getHealth(db);`

    Assert `r.score` is exactly 80 and `r.dimensions.consistency` is 1. Expected math: freshness 1.0 (both files parsed recently), consistency 1.0 (1 import, 0 broken), coverage 0.25 (testsRate 0.5 * lintFactor 0.5, no signals recorded), confidence 0.75 (0.5*1.0 + 0.5*0.5) -> composite 0.3+0.3+0.05+0.15 = 0.8 -> score 80.

    Do NOT modify the existing broken-import test or any other test in the file.
  </action>
  <verify>
    <automated>pnpm exec vitest run tests/health.test.ts</automated>
  </verify>
  <done>
    The new clean-fixture test passes (score === 80, consistency === 1); the existing 12 health tests still pass (13 total in the file).
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking-human">
  <name>Task 3: Verify @vitest/coverage-v8 package legitimacy before install</name>
  <what-built>Nothing yet — this gate precedes the @vitest/coverage-v8 install in Task 4.</what-built>
  <how-to-verify>
    Open https://www.npmjs.com/package/@vitest/coverage-v8 and confirm:
    1. Publisher is the vitest-dev org (same publisher as the already-installed vitest@2.1.9).
    2. Version 2.1.9 exists (matches the installed vitest minor).
    3. It is the official coverage provider referenced in vitest docs (not a typosquat).
    Then approve to let Task 4 run `pnpm add -D @vitest/coverage-v8@^2.1.9`.
  </how-to-verify>
  <resume-signal>Type "approved" or describe issues</resume-signal>
</task>

<task type="auto">
  <name>Task 4: Implement CI-gated coverage gate (devDep + vitest.config.ts)</name>
  <files>package.json, vitest.config.ts</files>
  <action>
    Install the coverage provider: `pnpm add -D @vitest/coverage-v8@^2.1.9` (pin to the same minor as the installed vitest 2.1.9).

    In vitest.config.ts, add a `coverage` block INSIDE the existing `test` object (coverage is a test-level option in vitest 2.x — `CoverageV8Options`). Preserve the existing `include`, `exclude`, and `environment` values exactly, including the smoke-test exclusion (`tests/smoke.test.ts` stays in the test.exclude list).

    The coverage block:
    ```
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types.ts'],
      enabled: process.env.CI === '1',
      reporter: ['text'],
      thresholds: { lines: 70 },
    },
    ```

    Mechanism: `coverage.enabled` (valid in vitest 2.1.9) gates the gate. When CI=1, coverage runs and the 70% lines threshold on src/ enforces (exit 1 if below). When CI is unset, coverage is skipped entirely so local `pnpm test` stays fast. vitest does NOT auto-enable coverage from the CI env var — the explicit `enabled: process.env.CI === '1'` is required.

    Ground truth: the current suite measures 72.14% lines on src/ (excluding src/types.ts), so the 70% threshold passes today. Do NOT add tests to inflate coverage and do NOT lower the threshold.
  </action>
  <verify>
    <automated>CI=1 pnpm test && pnpm test && pnpm exec tsc --noEmit</automated>
  </verify>
  <done>
    `CI=1 pnpm test` exits 0 AND prints a v8 coverage table showing src/ lines >= 70% (72.14% today). `pnpm test` without CI stays green and prints no coverage report. `pnpm exec tsc --noEmit` exits 0.
  </done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| npm registry -> node_modules | @vitest/coverage-v8 crosses the supply-chain boundary on install |

## STRIDE Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |
|-----------|----------|-----------|----------|-------------|-----------------|
| T-260809-01 | Tampering | npm install @vitest/coverage-v8 | high | mitigate | blocking-human checkpoint (Task 3) verifies npmjs.com/package/@vitest/coverage-v8 — official vitest-dev org, same publisher as installed vitest@2.1.9, version 2.1.9 exists |
</threat_model>

<verification>
- Task 1: `! grep -q "health restored" .planning/ROADMAP.md && grep -q "Score = 80 on a clean fixture" .planning/ROADMAP.md && grep -q "80 on clean fixture" .planning/STATE.md`
- Task 2: `pnpm exec vitest run tests/health.test.ts` (13 tests pass)
- Task 4: `CI=1 pnpm test` (exit 0 + v8 coverage table, src/ lines >= 70%), `pnpm test` (green, no coverage), `pnpm exec tsc --noEmit` (exit 0)
- Full gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test`
</verification>

<success_criteria>
- ROADMAP phase-2 SC1/SC3 match documented behavior: clean fixture scores 80 (not 100); the LLM repair path is "consulted, cached, logged" — never auto-applied.
- The clean-fixture score of 80 is pinned by a test in tests/health.test.ts.
- `CI=1 pnpm test` enforces >= 70% lines on src/ (measured 72.14% today); local `pnpm test` is unaffected.
</success_criteria>

<output>
Create `.planning/quick/260809-ops-fix-verification-blockers-from-phases-2-/260809-ops-SUMMARY.md` when done
</output>
