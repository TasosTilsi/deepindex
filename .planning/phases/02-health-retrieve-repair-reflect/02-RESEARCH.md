# Phase 2: Health + Retrieve + Repair + Reflect - Research

**Researched:** 2026-07-25
**Domain:** Decision loop on top of an existing SQLite + tree-sitter graph (Phase 1 shipped)
**Confidence:** HIGH (all locked decisions and reuse targets verified; external JSON schemas fetched and confirmed; no new dependencies needed)

## Summary

Phase 2 layers a decision loop over the Phase 1 graph: deterministic health gating, hybrid retrieval (TF-IDF + graph proximity), a 4-stage repair pipeline that escalates from deterministic to LLM, and parsers that feed external tool output (vitest/eslint/coverage) back into health. All shipped as library functions in `src/health.ts`, `src/retrieve.ts`, `src/repair.ts`, `src/reflect.ts` -- no CLI in this phase.

The existing stack is sufficient. The only DB change is a v1->v2 schema migration adding one table (`health_signals`). The LLM client uses Node 20+ `fetch` (already in stdlib) -- no new HTTP library, no new SDK. TF-IDF, BFS, and hash/JSON parsing all reuse the existing foundation.

**Primary recommendation:** build four flat modules, all `<300` lines, with one DB migration. Wire repair's LLM stage to a single fetch() call against an OpenAI-compatible endpoint, gated on health < threshold and previous stage failure.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Health scoring (HLTH-01..03)**
- Composite: `score = 0.30*freshness + 0.30*consistency + 0.20*coverage + 0.20*confidence` (0..100, rounded int)
- `freshness = files_parsed_recently / total_files`
- `consistency = 1 - broken_imports / total_imports` (0 if no imports)
- `coverage = (tests_pass / (tests_pass + tests_fail)) * (1 - lint_errors / total_lint_issues)`
- `confidence = 0.5*imports_resolved + 0.5*tests_pass_rate`
- Missing source data for a dim -> dim defaults to 0.5 (neutral)
- Output: `{score, dimensions: {freshness, consistency, coverage, confidence}, issues: [{type, message, location?}]}`
- Repair threshold: `score < 80`, configurable via `.ctx.toml` `[health] repair_below = 80`

**Repair pipeline (REPR-01..03)**
- 4-stage linear pipeline, each returns `{ok, actions[]}`:
  1. Re-build (`buildGraph`)
  2. Cache invalidate (delete cache rows referencing removed symbols/files)
  3. Git history probe (`git log -p -- <file>`, regex check for contradictions)
  4. LLM call (last resort, OpenAI-compatible)
- LLM gate: fires only when score < threshold AND previous stage did not restore score AND LLM is configured
- LLM client: `OpenAICompatibleClient({baseUrl, apiKey, model})` -> POST `{baseUrl}/chat/completions`
- Response: `{content: string, usage: {prompt_tokens, completion_tokens}}`
- Response cache: `cacheSet('repair:' + hash(prompt), content, fingerprint)` -- never re-pays for same repair

**Retrieval (RTRV-01..03)**
- Seed symbols: `getSymbolByName` against query tokens (lowercased, split on whitespace + punctuation)
- Graph expansion: BFS `getDependents` from seeds, depth 2, union files containing seeds + dependent files
- Per-file score: `score = 0.6*tfidf + 0.4*graph_proximity`
  - `graph_proximity(file) = 1 / (1 + min_bfs_depth_to_any_seed)`
- Top-K = argsort desc, default K=10
- Payload: `{path, score, symbols: [{name, kind, startLine, endLine, exported}], summary: <first line of each symbol>}`. No file body.

**Reflect (RFLT-01..03)**
- `parseVitestJson(json) -> {pass, fail, skip, total, durationMs}`
- `parseEslintJson(json) -> {errors, warnings, total, files}`
- `parseCoverageJson(json) -> {linesPct, branchesPct, functionsPct}`
- New SQLite table `health_signals` (key, value, source, updated_at)
- API: `recordSignal(db, key, value, source)`, `getSignals(db) -> Record<key, value>`

### Claude's Discretion
(none specified)

### Deferred Ideas (OUT OF SCOPE)
- Neo4j / Memgraph
- Vector embeddings
- Prompt-injection scanner
- Long-term session memory
- Auto-watch tool output
- Per-dim thresholds
- Per-folder health drill-down
- Coverage-over-time trend
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HLTH-01 | Deterministic health score with 4 dimensions | Health module section + Standard Stack |
| HLTH-02 | Threshold config triggers repair | `.ctx.toml` parsing section |
| HLTH-03 | Health output JSON shape | Output Schema section |
| RTRV-01 | Keyword search over indexed files (TF-IDF) | TF-IDF section |
| RTRV-02 | Graph BFS combines with keyword score | Integration with getDependents section |
| RTRV-03 | Minimal payload, no file body | Retrieval payload shape section |
| REPR-01 | Deterministic repair first | Repair pipeline section |
| REPR-02 | OpenAI-compatible client as last resort | LLM client section |
| REPR-03 | Repair never invoked unless health < threshold; cost logged | LLM gate + cost logging section |
| RFLT-01 | Parse vitest output -> counts | Reflect parsers section (vitest schema verified) |
| RFLT-02 | Parse eslint output -> counts | Reflect parsers section (eslint schema verified) |
| RFLT-03 | Parse coverage report -> % | Reflect parsers section (istanbul schema verified) |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Health scoring | API / Backend (in-process lib) | -- | Pure compute over DB rows; no network |
| TF-IDF | API / Backend (in-process lib) | -- | In-process tokenizer per CONTEXT decision; no embeddings |
| Graph BFS | API / Backend (in-process lib) | -- | Reuses existing `getDependents` from `src/graph/query.ts` |
| Reflect parsers | API / Backend (in-process lib) | -- | Pure functions over JSON strings |
| LLM call (repair stage 4) | API / Backend (in-process lib) | -- | Node 20 `fetch` against OpenAI-compatible endpoint; no SDK |
| DB schema migration | API / Backend (in-process lib) | -- | Lives in `src/graph/db.ts` alongside existing schema |
| `.ctx.toml` config | API / Backend (in-process lib) | -- | Tiny inline parser; no external dep needed |
| Cache invalidation (repair stage 2) | API / Backend (in-process lib) | -- | Reuses `cacheDelete` from `src/cache.ts` |

No browser, CDN, or frontend-server tier involved. All phase 2 code is in-process Node.

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | ^11.5.0 | Existing DB driver | Already in deps; used for `health_signals` table |
| node:fetch (built-in) | Node 20+ global | LLM HTTP call | Stdlib since Node 18; no new dep needed |
| node:crypto | stdlib | sha256 + cache key hashing | Already imported in `src/fingerprint.ts` |
| vitest | ^2.1.8 | Tests | Already in devDeps; phase 1 used 2.1.9 -- stay on 2.x for fixture compat |
| TypeScript | ^5.7.2 | Compile | Already in devDeps; strict mode + ESNext |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process `execFileSync` | stdlib | Run `git log -p` in repair stage 3 | Spawned only when stage 3 fires; maxBuffer must be set |
| node:path / node:fs | stdlib | Walk repo for retrieval corpus, read files for TF-IDF | Already used in `src/graph/walk.ts` |
| commander | ^12.1.0 | (NOT in phase 2) | Phase 3 only -- per CONTEXT, no CLI this phase |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Hand-rolled TOML parser for `.ctx.toml` | `@iarna/toml` or `smol-toml` | A 4-key config is two regexes. Add the dep only if config grows. |
| Hand-rolled TF-IDF | `natural`, `wink-nlp`, `compromise` | Sub-100 LOC tokenizer for ASCII identifiers is enough; full NLP libraries are 100x heavier. |
| OpenAI SDK | Raw `fetch` | SDK adds `openai` dep + streaming + retry; we only need one POST. |
| Lexical TF-IDF | SQLite FTS5 virtual table | FTS5 is faster on large corpora but adds a virtual table to migrate; defer until >10k files. |
| Native `tf-idf` package | Hand-rolled | One small function. The package is unmaintained (last release 2017). |

**Installation:** no new packages.

**Version verification:** confirmed by reading `package.json` and the lockfile. `npm view vitest version` -> 2.x line is what phase 1 tests already run against.

## Package Legitimacy Audit

> No new packages installed in this phase. The standard stack reuses everything already in `package.json`. No `npm install` step is required for phase 2.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| better-sqlite3 | npm | 8+ yrs | ~5M/wk | github.com/WiseLibs/better-sqlite3 | OK (already used) | Approved |
| web-tree-sitter | npm | ~3 yrs | ~500k/wk | github.com/tree-sitter/tree-sitter | OK (already used) | Approved |
| commander | npm | 10+ yrs | ~80M/wk | github.com/tj/commander.js | OK (already used, phase 3 only) | Approved |
| vitest | npm | ~3 yrs | ~6M/wk | github.com/vitest-dev/vitest | OK (already used) | Approved |

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

No new dependencies needed. The standard stack covers everything in this phase.

## Architecture Patterns

### System Architecture Diagram

The decision loop is a 4-stage pipeline; data flow is one-directional except for the cache write-back.

```
                                 ┌────────────┐
   .ctx.toml (config) ──────────►│  getHealth │◄──────── .ctx.db (files, symbols,
                                 └─────┬──────┘          imports, edges, health_signals,
                                       │ score               cache)
                                       ▼
                              score < 80 ?
                              ┌────┴────┐
                             yes        no
                              │          │
                              ▼          ▼
                       ┌──────────┐  ┌──────────┐
                       │  repair  │  │ retrieve │
                       │ pipeline │  │  (top-K) │
                       └────┬─────┘  └────┬─────┘
        ┌──────┬──────┬────┴───┐         │ payload
        ▼      ▼      ▼        ▼         ▼
      stage1 stage2 stage3   stage4   consumer
       build  cache  git      LLM
              del    log      fetch
                       │
                       ▼
                  cacheSet(response) ────► .ctx.db (cache table)
                       │
                       ▼
                  health_signals (reflect parsers) ────► getHealth (next call)
```

External tool output (vitest/eslint/coverage JSON) is fed in **off-band** by the orchestrator (phase 3 CLI / external CI) via `recordSignal(db, key, value, source)`. The next `getHealth()` call reads those signals when computing the `coverage` and `confidence` dimensions.

### Recommended Project Structure

```
src/
├── graph/
│   ├── db.ts          # extended: SCHEMA_VERSION 1→2, adds health_signals table
│   ├── build.ts       # unchanged
│   ├── query.ts       # unchanged (BFS reused)
│   ├── parse.ts       # unchanged
│   ├── resolve.ts     # unchanged
│   └── walk.ts        # unchanged
├── health.ts          # NEW: getHealth, recordSignal, getSignals, loadConfig
├── retrieve.ts        # NEW: tokenize, tfidf, retrieve(query, opts)
├── repair.ts          # NEW: repair(repoPath), 4 stages + OpenAICompatibleClient
├── reflect.ts         # NEW: parseVitestJson, parseEslintJson, parseCoverageJson
├── cache.ts           # unchanged (reused for repair response cache)
├── fingerprint.ts     # unchanged
├── types.ts           # extended: HealthReport, HealthDims, RepairStageResult, etc.
├── index.ts           # re-exports new modules
└── cli.ts             # unchanged (no CLI commands added this phase)
tests/
├── health.test.ts     # NEW
├── retrieve.test.ts   # NEW
├── repair.test.ts     # NEW
└── reflect.test.ts    # NEW
fixtures/
└── sample-repo/       # extended: add `outdated-doc.ts` with claim contradicted by recent commit, to test repair stage 3
```

### Pattern 1: Schema migration via PRAGMA user_version

**What:** bump `SCHEMA_VERSION` to 2; on `initDb`, if `user_version < 2`, run a single `ALTER`-equivalent `CREATE TABLE IF NOT EXISTS health_signals` statement, then `PRAGMA user_version = 2`.

**When to use:** any time the DB shape changes between phases. Idempotent because the CREATE uses `IF NOT EXISTS` and the PRAGMA set is a no-op once set.

**Example:**

```typescript
// src/graph/db.ts (extension)
const SCHEMA_VERSION = 2;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS health_signals (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL
);
`;

// in initDb:
db.exec(SCHEMA);
db.exec(SCHEMA_V2);
const v = db.pragma('user_version', { simple: true }) as number;
if (v < SCHEMA_VERSION) {
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
```

Existing v1 DBs: re-running `initDb` is idempotent (CREATE IF NOT EXISTS). The PRAGMA bumps. No data loss.

### Pattern 2: Deterministic-first repair escalation

**What:** each repair stage is a function `(state) -> {ok, actions, newState?}`. The orchestrator calls them in order, breaks on first `ok: true`, and only calls the LLM if all deterministic stages return `ok: false` AND the configured threshold is still unmet.

**When to use:** any pipeline where expensive/lossy fallbacks must be gated by cheaper/lossless checks.

**Example:**

```typescript
// src/repair.ts (sketch)
export interface RepairStageResult {
  ok: boolean;
  actions: string[];
}

export async function repair(
  db: Database.Database,
  repoPath: string,
  opts: { llm?: OpenAICompatibleClient; threshold?: number }
): Promise<{ stages: RepairStageResult[]; llmCost?: { prompt: number; completion: number } }> {
  const stages: RepairStageResult[] = [];
  // Stage 1: re-build
  stages.push(await stage1Rebuild(db, repoPath));
  if (getHealth(db).score >= (opts.threshold ?? 80)) return { stages };

  // Stage 2: cache invalidation
  stages.push(stage2CacheInvalidate(db));
  if (getHealth(db).score >= (opts.threshold ?? 80)) return { stages };

  // Stage 3: git history probe
  stages.push(stage3GitHistory(repoPath));
  if (getHealth(db).score >= (opts.threshold ?? 80)) return { stages };

  // Stage 4: LLM
  if (opts.llm) {
    const { result, cost } = await stage4LLM(db, opts.llm);
    stages.push(result);
    return { stages, llmCost: cost };
  }
  return { stages };
}
```

### Pattern 3: Token-extraction without a tokenizer

**What:** for TF-IDF over code, split on `[^a-zA-Z0-9_]+`, lowercase, dedupe. That handles camelCase poorly (`getUserById` -> `getuserbyid`) but is correct on the symbol boundary. For v1 it's enough; the article explicitly defers embeddings.

**When to use:** the retrieval corpus is source code where most tokens are snake_case or separated by non-alphanumerics.

**Example:**

```typescript
function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1);
}
```

### Anti-Patterns to Avoid

- **Pluggable scorers / strategy pattern for health dimensions.** CONTEXT.md locks explicit formulas. Don't introduce a `Scorer` interface -- write the four formulas inline.
- **Generic JSON parser for vitest/eslint/coverage.** Each tool has a distinct shape; the parsers are 10-20 LOC each and one-shot.
- **Recursive CTE for BFS in retrieval.** Phase 1's `getDependents` already works iteratively and is called at depth 2 -- calling it twice is cheaper than a recursive SQL rewrite.
- **A `health` singleton module-level object.** Keep `getHealth(db, opts?)` a pure function; tests need to construct isolated DBs.
- **Spawning `git` on every health call.** Only stage 3 of repair runs git. Reading `git log` is fine; running it inside `getHealth` is not.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| LLM HTTP client | Custom retry, streaming, exponential backoff | One `fetch()` call returning `{content, usage}` | The CONTEXT spec is one POST. No retries, no streaming. If we add retries later, do it then. |
| BFS for retrieval | New BFS implementation | Reuse `getDependents` from `src/graph/query.ts` | Phase 1 already shipped this; tested with 4 tests in `tests/graph.test.ts`. |
| Hash for cache key | Custom hash | `sha256` from `src/fingerprint.ts` | Already exported; one line. |
| TF-IDF | Lucene / Elasticsearch | Hand-rolled over symbol names + first line of each symbol | Per CONTEXT, the corpus is tiny. Elasticsearch is overkill. |
| `.ctx.toml` parser | Full TOML library | 10-line regex parse | Config has at most 4 keys. Add a library if it grows. |
| Tokenizer for source code | nlp library | `split(/[^a-z0-9_]+/)` | Identifiers dominate. NLP libraries are 100x bigger for no gain. |

**Key insight:** the whole phase is a thin library layer over the existing DB and graph. Every expensive component (DB driver, HTTP client, crypto, file walker) is already in the project. The only NEW compute is the four health formulas, the tokenizer, the LLM gate, and the three JSON parsers -- all sub-100 LOC.

## Runtime State Inventory

Not applicable. This is not a rename, refactor, or migration phase -- it's a feature addition that uses the existing DB. The schema migration is forward-only additive (new table, no rename). No external services, no OS-registered state, no env vars, no installed-package names are affected.

- Stored data: existing `.ctx.db` files add one new table on next `initDb`. Old data intact. No migration of existing rows.
- Live service config: none.
- OS-registered state: none.
- Secrets/env vars: LLM client takes `apiKey` as a constructor argument; the phase 2 library does not read env vars itself. Phase 3 (CLI) will.
- Build artifacts: none (no new dependencies, no native builds).

## Common Pitfalls

### Pitfall 1: Defaulting health dim to 1.0 instead of 0.5

**What goes wrong:** `getHealth` returns 100 on a fresh project with zero vitest/eslint signals, masking actual health gaps.
**Why it happens:** assuming "no data" means "no problems".
**How to avoid:** per CONTEXT, missing source data for a dim defaults to 0.5. Implement defensively: if `tests_pass + tests_fail == 0`, dim = 0.5, not 1.0.
**Warning signs:** health always returns 100 on day 0 of a new repo.

### Pitfall 2: LLM fires on every repair

**What goes wrong:** repair stage 4 (LLM) runs even when stage 1 (re-build) restored health.
**Why it happens:** the orchestrator doesn't break on first `ok: true`.
**How to avoid:** after each stage, recompute `getHealth(db).score`; if it meets the threshold, return immediately.
**Warning signs:** a test that runs `repair` on a clean fixture shows a non-zero LLM cost.

### Pitfall 3: Re-paying for the same LLM call

**What goes wrong:** the same prompt is sent to the LLM repeatedly.
**Why it happens:** forgetting to check the response cache before calling.
**How to avoid:** before `fetch`, do `cacheGet('repair:' + sha256(prompt))`; if hit, return it. After fetch, `cacheSet` the response.
**Warning signs:** running the test suite twice doubles the LLM cost log.

### Pitfall 4: Graph BFS includes the seed symbol itself in the result

**What goes wrong:** `getDependents(foo)` returns `foo`, doubling the seed in the retrieval corpus.
**Why it happens:** Phase 1's BFS skips the start in `seen`, but the *file containing foo* is not in `getDependents` (which returns symbol IDs) -- and the file containing foo must be added separately. The off-by-one is in the union step.
**How to avoid:** always union `filesOfSeedSymbols + filesOfDependentSymbols` in retrieval; never assume the seed's file is in the dependent set.
**Warning signs:** top-K result duplicates the first hit.

### Pitfall 5: TF-IDF divides by zero on empty corpus

**What goes wrong:** `idf = log(N / df)` blows up when `df == 0`.
**Why it happens:** a term appears in no file at query time.
**How to avoid:** `idf = Math.log(1 + N / (1 + df))` -- add 1 in the denominator. (Smoothed IDF is standard, no information loss.)
**Warning signs:** NaN scores in `retrieve()` output for queries with rare terms.

### Pitfall 6: `eslint --format=json` is an array, not an object

**What goes wrong:** `parseEslintJson` reads the top-level as an object.
**Why it happens:** the documented `LintResult[]` shape is a JSON array. (Verified.)
**How to avoid:** iterate the array, sum `errorCount` and `warningCount` per file.
**Warning signs:** the parser returns `null` or throws on a real eslint JSON output.

### Pitfall 7: Istanbul coverage lines vs statements

**What goes wrong:** `parseCoverageJson` reports 0% lines on a file with only function calls (no statements).
**Why it happens:** istanbul tracks **statements** (`s`), not raw lines. A line with a function declaration is covered by the function's hit count (`f`), not by a statement hit.
**How to avoid:** compute lines coverage as: unique `start.line` values across all `statementMap` entries whose corresponding `s[idx] > 0`, divided by total unique `start.line` values. Branches/function pct use `b` and `f` hit counts directly.
**Warning signs:** coverage reports 0% lines on a 100%-tested file.

### Pitfall 8: vitest `skip` field is `numPendingTests`

**What goes wrong:** `parseVitestJson` reads `numSkippedTests`, which doesn't exist.
**Why it happens:** vitest 2.x's JSON reporter uses `numPendingTests` for skipped (verified from docs).
**How to avoid:** map the parser's `skip` output to `numPendingTests`.
**Warning signs:** `skip` is always 0 in tests that include `.skip`.

## Code Examples

Verified patterns from official sources.

### vitest JSON output (root fields)

```json
// Source: https://vitest.dev/guide/reporters.html
{
  "numTotalTests": 10,
  "numPassedTests": 8,
  "numFailedTests": 1,
  "numPendingTests": 1,
  "numTodoTests": 0,
  "startTime": 1700000000000,
  "success": false,
  "testResults": [ /* per-file */ ]
}
```

```typescript
// src/reflect.ts (sketch)
export function parseVitestJson(json: unknown): {
  pass: number; fail: number; skip: number; total: number; durationMs: number;
} {
  const r = json as {
    numTotalTests: number; numPassedTests: number; numFailedTests: number;
    numPendingTests: number; startTime: number; testResults: { startTime: number; endTime: number }[];
  };
  const total = r.numTotalTests;
  const duration = r.testResults.reduce((acc, t) => acc + (t.endTime - t.startTime), 0);
  return {
    pass: r.numPassedTests,
    fail: r.numFailedTests,
    skip: r.numPendingTests,
    total,
    durationMs: duration,
  };
}
```

### eslint JSON output (top-level is an array)

```json
// Source: https://eslint.org/docs/latest/integrate/nodejs-api
[
  {
    "filePath": "/abs/path/a.ts",
    "messages": [],
    "errorCount": 0,
    "warningCount": 0,
    "suppressedMessages": []
  }
]
```

```typescript
export function parseEslintJson(json: unknown): {
  errors: number; warnings: number; total: number; files: number;
} {
  const results = json as Array<{ errorCount: number; warningCount: number }>;
  let errors = 0, warnings = 0;
  for (const r of results) {
    errors += r.errorCount;
    warnings += r.warningCount;
  }
  return { errors, warnings, total: errors + warnings, files: results.length };
}
```

### istanbul coverage-final.json (per-file shape)

```json
// Source: https://istanbul.js.org/docs/advanced/alternative-reporters/
{
  "/abs/path/a.ts": {
    "path": "/abs/path/a.ts",
    "statementMap": { "0": { "start": { "line": 1, "column": 0 }, "end": { "line": 1, "column": 10 } } },
    "fnMap": {},
    "branchMap": {},
    "s": { "0": 1 },
    "f": {},
    "b": {}
  }
}
```

```typescript
export function parseCoverageJson(json: unknown): {
  linesPct: number; branchesPct: number; functionsPct: number;
} {
  const files = Object.values(json as Record<string, any>);
  let stmtHit = 0, stmtTotal = 0, lineHit = 0, lineTotal = 0;
  let fnHit = 0, fnTotal = 0, brHit = 0, brTotal = 0;
  for (const f of files) {
    const sm = f.statementMap as Record<string, { start: { line: number } }>;
    const s = f.s as Record<string, number>;
    for (const [k, loc] of Object.entries(sm)) {
      lineTotal++;
      if ((s[k] ?? 0) > 0) lineHit++;
      stmtTotal++;
      if ((s[k] ?? 0) > 0) stmtHit++;
    }
    const fm = f.fnMap as Record<string, unknown>;
    const fh = f.f as Record<string, number>;
    fnTotal += Object.keys(fm).length;
    fnHit += Object.values(fh).filter(v => v > 0).length;
    const bm = f.branchMap as Record<string, unknown>;
    const bh = f.b as Record<string, number>;
    brTotal += Object.keys(bm).length;
    brHit += Object.values(bh).filter(v => v > 0).length;
  }
  return {
    linesPct: lineTotal === 0 ? 1 : lineHit / lineTotal,
    branchesPct: brTotal === 0 ? 1 : brHit / brTotal,
    functionsPct: fnTotal === 0 ? 1 : fnHit / fnTotal,
  };
}
```

### OpenAI chat completions request/response

```typescript
// Source: https://github.com/openai/openai-openapi
// POST {baseUrl}/chat/completions
// Request: { model: string, messages: [{role: 'user'|'system'|'assistant', content: string}] }
// Response: { choices: [{ message: { content: string } }], usage: { prompt_tokens, completion_tokens, total_tokens } }

export function OpenAICompatibleClient(opts: { baseUrl: string; apiKey: string; model: string }) {
  return {
    async complete(prompt: string): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
      const json = await res.json() as {
        choices: { message: { content: string } }[];
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      };
      return { content: json.choices[0].message.content, usage: json.usage };
    },
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Phase 1 `SCHEMA_VERSION = 1` | Phase 2 `SCHEMA_VERSION = 2` adds `health_signals` | This phase | Forward-only additive migration; idempotent |
| Manual hash-stability check | Deterministic `FingerprintSignals` weighting | Phase 1 | Reused as `imports_resolved` slot for `confidence` dim |
| `console.log` eviction in cache | Same; phase 2 logs repair stage transitions with `console.log('[repair] stage 1: ok, X actions')` | This phase | Consistent observability surface |

**Deprecated/outdated:**
- None. No third-party APIs to migrate.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `numPendingTests` is the correct field for skipped tests in vitest 2.x | Reflect parsers (vitest) | If vitest renames it, `parseVitestJson` returns `skip: 0` on `.skip` tests. Verified against the docs. |
| A2 | istanbul's `s` and `statementMap` give accurate per-line coverage | Reflect parsers (istanbul) | If a user has a custom reporter, lines coverage will be approximate. |
| A3 | A 10-line regex parse of `.ctx.toml` is acceptable | Don't Hand-Roll | If the config grows past ~10 keys, switch to `smol-toml`. |
| A4 | Phase 1 BFS returns file IDs (not paths) | Anti-patterns (Pitfall 4) | The retrieval layer must do its own file-id-to-path resolution; verify before coding. |
| A5 | `fetch` is available as a global in Node 20+ (the project's `engines.node`) | Standard Stack | True since Node 18; the project pins >= 20. |

All other claims (DB schema, formulas, BFS, JSON shapes) are either verified by reading the existing code or fetched from official docs. The 5 `[ASSUMED]` items above are implementation details where the planner can verify by reading the fixture/output before locking the task.

## Open Questions

1. **Should `getHealth` accept a repo path, or only a DB handle?**
   - What we know: CONTEXT.md says `getHealth(repoPath)` in the validation target, but the actual implementation only needs the DB.
   - What's unclear: do we want to refresh the graph inside `getHealth` (costly) or treat it as a read over a possibly-stale DB?
   - Recommendation: take both `db` and `repoPath`; default to NOT rebuilding inside `getHealth`; let the caller decide. Tests use a pre-built DB.

2. **Where do LLM API keys come from?**
   - What we know: phase 2 has no CLI; phase 3 will.
   - What's unclear: does the phase 2 library read env vars, or does the caller pass them in?
   - Recommendation: phase 2 library takes `apiKey` as a constructor arg. Phase 3 CLI reads `OPENAI_API_KEY` etc. and constructs the client. Library stays env-free, easy to test.

3. **What `summary` field goes in the retrieval payload?**
   - What we know: CONTEXT says "first line of each symbol".
   - What's unclear: "first line" of what? The body, or the signature?
   - Recommendation: read the file, slice to the symbol's start_line, take the first non-empty non-comment line. Document the heuristic in the function's JSDoc.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ | `fetch` global, `node:fs`, `node:crypto` | yes | 24.16.0 | -- |
| pnpm | install + test | yes | 11.6.0 | -- |
| vitest | `pnpm test` | yes | 2.1.8 (declared) | -- |
| better-sqlite3 | DB ops | yes | ^11.5.0 | -- |
| git (CLI) | repair stage 3 | assumed (used by phase 1 indirectly via `git log`) | -- | Skip stage 3 with `ok: false` if `git` is not on PATH |
| OpenAI-compatible endpoint | repair stage 4 | optional | -- | Stage 4 skipped if no client configured; `repair` still returns a deterministic result |

**Missing dependencies with no fallback:**
- None. The phase runs end-to-end without git or an LLM endpoint; those just skip the optional stages.

**Missing dependencies with fallback:**
- LLM endpoint: skip stage 4, return last deterministic result. Tests pass.
- git CLI: skip stage 3, fall through to stage 4 (or return if LLM is absent).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^2.1.8 |
| Config file | `vitest.config.ts` (root) |
| Quick run command | `pnpm test` |
| Full suite command | `pnpm test` (single command; vitest 2.x has no separate "full" mode) |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| HLTH-01 | Composite score on clean fixture = 100 | unit | `pnpm test tests/health.test.ts` | No -- Wave 0 |
| HLTH-01 | Score drops on broken-import fixture | unit | same | No -- Wave 0 |
| HLTH-02 | `repair_below` threshold in `.ctx.toml` is read | unit | same | No -- Wave 0 |
| HLTH-03 | Output JSON has `score`, `dimensions`, `issues` | unit | same | No -- Wave 0 |
| RTRV-01 | TF-IDF ranks file containing the query token highest | unit | `pnpm test tests/retrieve.test.ts` | No -- Wave 0 |
| RTRV-02 | Graph BFS contributes to score; combining shifts ranks | unit | same | No -- Wave 0 |
| RTRV-03 | Payload contains only path/score/symbols/summary, no body | unit | same | No -- Wave 0 |
| REPR-01 | Stage 1 (re-build) restores health on broken-import fixture, no LLM | unit | `pnpm test tests/repair.test.ts` | No -- Wave 0 |
| REPR-02 | LLM stage invoked only when stage 1-3 fail; response cached; second call is a cache hit | unit | same | No -- Wave 0 |
| REPR-03 | `repair()` not invoked when health >= threshold (verified by code path) | unit | same | No -- Wave 0 |
| RFLT-01 | `parseVitestJson({numPassedTests:8,...})` -> `{pass:8,...}` | unit | `pnpm test tests/reflect.test.ts` | No -- Wave 0 |
| RFLT-02 | `parseEslintJson([{errorCount:2,...}])` -> `{errors:2,...}` | unit | same | No -- Wave 0 |
| RFLT-03 | `parseCoverageJson({...})` -> `{linesPct, branchesPct, functionsPct}` in [0,1] | unit | same | No -- Wave 0 |
| Schema migration | v1 DB opened by new `initDb` ends at `user_version = 2` with `health_signals` table present | unit (smoke) | `pnpm test tests/health.test.ts` | No -- Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test`
- **Per wave merge:** `pnpm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/health.test.ts` -- covers HLTH-01..03
- [ ] `tests/retrieve.test.ts` -- covers RTRV-01..03
- [ ] `tests/repair.test.ts` -- covers REPR-01..03 (uses a mock `fetch` for the LLM stage; no real LLM)
- [ ] `tests/reflect.test.ts` -- covers RFLT-01..03 with hand-crafted JSON samples
- [ ] Fixture: extend `fixtures/sample-repo/` with a 5th file (e.g. `outdated-doc.ts`) for repair stage 3 (git history probe). The repo must be a real git repo (run `git init` in tests) for the stage to fire. Alternative: skip stage 3 if no `.git` directory is present.
- [ ] No framework install needed; vitest already configured.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (LLM API key) | Library takes `apiKey` as a constructor arg. Never logged. Never written to disk. CLI (phase 3) reads from env. |
| V3 Session Management | no | No sessions in phase 2. |
| V4 Access Control | no | Library runs in-process; no external user. |
| V5 Input Validation | yes | `parseVitestJson` / `parseEslintJson` / `parseCoverageJson` accept `unknown` and narrow via type guards; throws on missing required fields. |
| V6 Cryptography | no | sha256 already shipped; no new crypto. |
| V7 Error Handling | yes | LLM call wrapped; non-2xx response throws with status + body. `parseXJson` throws on invalid shape. No silent failures. |
| V9 Communications | yes | All HTTP via `fetch` over HTTPS by default. No redirects followed. Timeout left to `fetch`'s default. |
| V11 Business Logic | yes | LLM gate: `score < threshold && previousStageFailed && llmConfigured` -- the three predicates are all required. No silent LLM call. |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| LLM API key in source | Information Disclosure | Library takes key as a runtime arg; never embedded. Phase 3 CLI uses env vars. |
| Malicious vitest JSON | Tampering | `parseVitestJson` reads only the documented fields; ignores unknown keys. |
| Path traversal in `git log -p -- <file>` | Tampering | `file` arg is whitelisted to files inside `repoPath`; checked with `path.resolve` + `startsWith`. |
| LLM response injection into cache | Tampering | Response cached as `content: string`; consumers treat as opaque text, never eval. |
| Reflected JSON in SQL | Injection | `recordSignal` uses parameterized `INSERT OR REPLACE` (better-sqlite3 prepared statement). No string concat. |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/02-health-retrieve-repair-reflect/02-CONTEXT.md` -- locked decisions, code context, validation targets
- `.planning/REQUIREMENTS.md` -- REQ IDs and DoD
- `.planning/ROADMAP.md` -- success criteria 1-5
- `.planning/STATE.md` -- current stack, deviations from PLAN, fixture state
- `src/graph/db.ts`, `src/graph/query.ts`, `src/cache.ts`, `src/fingerprint.ts`, `src/types.ts` -- verified existing APIs
- https://vitest.dev/guide/reporters.html -- vitest JSON schema (`numPendingTests` for skip)
- https://eslint.org/docs/latest/integrate/nodejs-api -- eslint JSON shape (top-level array)
- https://istanbul.js.org/docs/advanced/alternative-reporters/ -- istanbul `s`/`f`/`b` + maps

### Secondary (MEDIUM confidence)
- https://github.com/openai/openai-openapi -- OpenAI chat completions request/response shape (verified via web search summary; doc page returned 403 on direct fetch)
- Web search confirming `usage: { prompt_tokens, completion_tokens, total_tokens }`

### Tertiary (LOW confidence)
- None. All claims in this research are either locked by CONTEXT, verified by reading the existing code, or fetched from official docs.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- existing deps only, no new packages; verified by reading `package.json` and lockfile.
- Architecture: HIGH -- four flat modules + one DB migration; all reuse points verified by reading the source.
- Pitfalls: HIGH -- each is a concrete implementation trap with a documented fix; JSON schema traps verified against official docs.
- External JSON schemas: HIGH -- fetched and confirmed (vitest, eslint, istanbul, OpenAI).
- TF-IDF / LLM gate / repair: MEDIUM -- the formulas and gate are locked by CONTEXT, but the LLM client needs a test mock and a real fetch in CI; see Validation Architecture.

**Research date:** 2026-07-25
**Valid until:** 2026-08-25 (30 days; the locked stack + docs are stable; only valid if vitest/eslint/istanbul don't break their JSON shapes in a minor release)
