---
phase: 3
name: Watcher + Adapter + CLI + Tests
date: 2026-07-26
---

# Phase 3: Watcher + Adapter + CLI + Tests - Context

**Gathered:** 2026-07-26
**Status:** Ready for planning

<domain>

## Phase Boundary

Surface the framework. The library exists; this phase puts a process boundary
on it. Four deliverables: a `chokidar` watcher that invalidates cache on file
change, a `src/adapter-claude-code.ts` module that returns the same JSON
shape as the serve endpoint, commander CLI commands for the six user-facing
verbs, and a vitest suite that proves the loop end-to-end against
`fixtures/sample-repo`.

This phase adds **one dependency** (`chokidar`). Everything else reuses
phase 1/2 code or Node 20 stdlib. No new business logic — this is wiring.

</domain>

<decisions>

## Implementation Decisions

User granted full discretion with a zero-cost budget. Every decision below
favors the lowest-cost option that meets the requirement.

### Watcher (WTCH-01..03)

- **D-01:** New dep `chokidar` (latest v4, zero-config, native fs.watch
  wrapper). Chosen because stdlib `fs.watch` is recursive-only on macOS and
  unreliable on Linux for editor "save" bursts. No alternative in stdlib.
- **D-02:** Debounce window = **250ms** (per WTCH-02, default in
  REQUIREMENTS.md). Coalesce by absolute path. Single timer per path.
- **D-03:** Default watch roots = `cwd` and `[cwd]/src` if it exists.
  Respect `.gitignore` by default. `--no-ignore` flag passes
  `ignored: null` to chokidar. `.ctx/` and `node_modules/` always ignored
  even with `--no-ignore`.
- **D-04:** On event: print `invalidated: <relative-path>` to stdout
  (one line per file, post-debounce), then call
  `cacheDelete(db, 'summary:' + sha256(path))` to drop only the affected
  summary cache entry. **Do NOT auto-trigger `repair()`.** Repair is a
  user-invoked verb; watcher only invalidates. Rationale: silent LLM
  calls violate REPR-03 and burn tokens without consent.
- **D-05:** SIGINT/SIGTERM handler closes chokidar and exits 0.
  `await chokidar.close()` first, then `process.exit(0)`. Uncaught
  exceptions during watch → log + exit 1 (no zombie process).
- **D-06:** `awaitWriteFinish: { stabilityThreshold: 100, pollInterval:
  50 }` on chokidar — handles editors that save-then-rename atomically
  (vim, IntelliJ). Adds 100ms latency per event; acceptable.

### Adapter (ADPT-01)

- **D-07:** New module `src/adapter-claude-code.ts`. Pure function, no
  I/O of its own. Signature: `adaptClaudeCode(task: string, repoPath:
  string, opts?: {topK?: number, dbPath?: string}) → Promise<AdapterResult>`.
- **D-08:** Output shape = **identical to `serve` endpoint response**:
  ```ts
  type AdapterResult = {
    task: string;
    topFiles: Array<{path: string, score: number, symbols: Array<{name: string, kind: string, startLine: number, endLine: number, exported: boolean}>, summary: string}>;
    neighborhood: Array<{symbol: string, file: string, depth: number}>;
    health: HealthReport;
  };
  ```
  Same `retrieve` + `getDependents`/`getDependencies` already in phase 2.
  No new ranking logic. Drop-in consumable by Claude Code prompt.
- **D-09:** `topK` default = 10 (matches `DEFAULT_TOP_K` from
  `src/retrieve.ts`). `dbPath` default = `.ctx.db` (matches CLI default).
- **D-10:** No HTTP transport. Adapter is a library import, not a
  process. Claude Code imports it via `import { adaptClaudeCode } from
  'contextkit'`. If a process boundary is needed later, that's a
  separate phase.

### CLI (CMD-01..06)

- **D-11:** Extend existing `src/cli.ts`. Six commands total. All
  commands accept `--db <path>` (default `.ctx.db`). Build command also
  accepts `<repo>` positional (already does).
- **D-12:** Output format per command:
  - `build` → human, one line summary (already exists).
  - `status` → **JSON** of `getHealth()` to stdout. Exit 0 if
    `score >= threshold`, else 1. `loadConfig` reads `.ctx.toml` for
    threshold.
  - `repair` → human-readable stages 1→4 with before/after `score`
    printed. JSON flag `--json` switches to machine output.
  - `serve` → **JSON only** (it's an API). No human output unless error.
  - `watch` → human event lines (D-04). No `--json` mode.
  - `retrieve <query>` → human, top-K list. `--json` flag for machine.
- **D-13:** Exit codes:
  - 0 = success / healthy
  - 1 = unhealthy (status) or repair couldn't reach threshold
  - 2 = infra error (DB missing, repo not found, port in use)
- **D-14:** Stderr for all errors, stdout for all data. Never mix.
  Errors include the failed command name in the prefix:
  `ctx build: repository not found: /foo`.
- **D-15:** `serve` uses Node 20 stdlib `node:http`. No `express`/`fastify`.
  Single route: `POST /context` with body `{task: string, repoPath: string,
  topK?: number}`. Returns 200 + JSON, 400 on bad body, 500 on internal.
  Port: **7331** (per REQUIREMENTS.md), overridable via `--port` flag.
- **D-16:** Add `build` `--rebuild` flag (re-parse all, ignore hash) for
  debugging. Cheap to add, no new module.

### Tests (TEST-01..03)

- **D-17:** Vitest config extends existing. New tests:
  - `tests/cli.test.ts` — spawn `tsx src/cli.ts <cmd> <args>` via
    `node:child_process.spawn`, assert on stdout/exit code. One test per
    command (6 tests).
  - `tests/adapter.test.ts` — pure function test, mock-free. Calls
    `adaptClaudeCode` against `fixtures/sample-repo` (already
    indexed by `beforeAll`), asserts shape + non-empty topFiles.
  - `tests/watcher.test.ts` — uses `tmpdir` fixture, creates 1 file,
    starts chokidar with 100ms debounce, writes again, awaits event,
    asserts `cacheDelete` was called.
  - `tests/smoke.test.ts` — orchestrates: `ctx build fixtures/sample-repo`
    → `ctx status` (assert healthy) → `ctx retrieve auth` (assert
    non-empty). Sequential, not parallel. Last test file vitest picks up.
- **D-18:** `fixtures/sample-repo` already exists with broken import
  (from phase 1). Extend it with a `with-comments.ts` file
  (already there) so `retrieve` has a stable symbol to find. **No new
  fixture repo.**
- **D-19:** Coverage gate: **70% lines on `src/`** (per ROADMAP
  success criteria). `pnpm test` runs `vitest run --coverage`. Vitest
  coverage v8 provider, already in vitest. No new dep.
- **D-20:** `pnpm run smoke` (per ROADMAP) = `tsx tests/smoke.test.ts`
  added to `package.json scripts`. The smoke test IS the smoke script.
  Fewer files. Self-checks the same way the unit tests do.

### Packaging

- **D-21:** `package.json` `bin`: existing `ctx: dist/cli.js` already
  declared. Build step (`pnpm build` → `tsc`) emits `dist/cli.js` with
  shebang. No change.
- **D-22:** `pnpm test` already runs `vitest run`. Extend to
  `vitest run --coverage` only when `CI=1` (so local dev stays fast).
- **D-23:** Add `chokidar` to `dependencies` (not devDependencies — it's
  needed at runtime). Pin `^4.0.0` (v4 supports Node 20 natively).

### Claude's Discretion

- CLI argument parsing style for nested flags (commander already in use;
  follow existing patterns in `src/cli.ts`).
- Error message wording (D-14 prefix is the only constraint).
- Order of CLI command registration in `src/cli.ts` (alphabetical or
  by importance — Claude's call).
- Test assertion style (node:assert vs vitest `expect` — match the
  existing files in `tests/`, which use `expect`).

</decisions>

<canonical_refs>

## Canonical References

Downstream agents MUST read these before planning or implementing.

### Requirements
- `.planning/REQUIREMENTS.md` — WTCH-01..03, ADPT-01, CMD-01..06, TEST-01..03
- `.planning/ROADMAP.md` — Phase 3 success criteria (5 items)
- `.planning/PROJECT.md` — project mission, target users (contextkit v1)

### Phase 1 + 2 decisions to honor
- `.planning/phases/01-foundation/01-CONTEXT.md` — graph/cache/fingerprint shape
- `.planning/phases/02-health-retrieve-repair-reflect/02-CONTEXT.md` — health
  dimensions, repair pipeline, retrieve ranking, reflect parsers. Phase 3
  wires these as CLI commands; do not change the underlying logic.

### Code to extend
- `src/cli.ts` — existing commander setup with `build` + `status`. Add
  `repair`, `serve`, `watch`, `retrieve`. Keep `<repo>` positional for
  build, add `--db` flag to all.
- `src/health.ts` — `getHealth`, `loadConfig`, `DEFAULT_HEALTH_CONFIG`
  already exported. CLI `status` calls these directly.
- `src/retrieve.ts` — `retrieve`, `tokenize`, `tfidf`, `DEFAULT_TOP_K`
  already exported. CLI `retrieve` and adapter call these.
- `src/repair.ts` — `repair`, `stage1Rebuild`..`stage4LLM` already
  exported. CLI `repair` calls `repair()` and prints results.
- `src/reflect.ts` — `parseVitestJson`/`parseEslintJson`/`parseCoverageJson`
  already exported. Phase 3 adds a `ctx reflect` subcommand that
  reads JSON from stdin/file and calls `recordSignal` (or wires it into
  `repair` flow). The reflect parsers are not invoked by build/status/serve
  unless user pipes data — keep it that way.
- `src/index.ts` — public API. Add `adaptClaudeCode` export.
- `src/graph/db.ts` — schema is v2. No new tables for phase 3.
- `package.json` — `commander`, `tsx`, `vitest` already deps. Add
  `chokidar` only.

### Docs
- `context-engineering-article.txt` — Masood 2025. Phase 3 is the
  "harness boundary" the article describes (Principle 7: RAG integration
  via adapter; Principle 4: minimal payload).

No external specs beyond REQUIREMENTS.md.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets
- `src/cli.ts` — commander `Command` instance already created. Six new
  commands attach to `program.command('...')`. Pattern is set; replicate.
- `src/health.ts:getHealth` — pure function, returns JSON. CLI `status`
  just `console.log(JSON.stringify(report, null, 2))`.
- `src/retrieve.ts:retrieve` — pure function `(db, query, opts) → hits`.
  CLI `retrieve` wraps with arg parsing; adapter calls directly.
- `src/repair.ts:repair` — async, returns `{before: HealthReport,
  after: HealthReport, stages: RepairStageResult[], cost: RepairCost}`.
  CLI `repair` prints stages + before/after.
- `src/index.ts` — re-exports all phase 2 modules. Add `adaptClaudeCode`
  and any new phase 3 helpers (`serve`, `createWatcher`).
- `tests/*.test.ts` — pattern: `import { describe, it, expect, beforeAll }`
  from `vitest`. Use `tmpdir` from `node:os` for watcher test.
- `fixtures/sample-repo` — has broken import (`a.ts → b.ts → missing.ts`)
  + `with-comments.ts` with `// TODO` markers. Sufficient for all
  phase 3 tests.

### Established Patterns
- **No module-level singletons** in phase 1/2. Every function takes
  `db` or `repoPath` explicitly. Phase 3 follows — watcher takes
  `dbPath`, serves takes `dbPath`, adapter takes `dbPath`. No global
  state.
- **Pure-function top-level modules** in `src/` (no `graph/` subdir for
  phase 3 modules). `src/watcher.ts`, `src/adapter-claude-code.ts`,
  `src/serve.ts`.
- **Tests mirror src structure**: `tests/watcher.test.ts` tests
  `src/watcher.ts`, etc. Existing convention.
- **No LLM calls in phase 3 by default.** Repair is opt-in via `ctx
  repair` command. Watcher never auto-repairs.

### Integration Points
- `src/cli.ts:51` — `program.parseAsync(process.argv)` already async.
  New commands that are async (serve, watch, repair) plug in directly.
- `src/index.ts:1-32` — public API surface. Add phase 3 exports.
- `package.json:scripts` — extend `test` to add `--coverage` under CI.
  Add `smoke: tsx tests/smoke.test.ts`. Add `start: node dist/cli.js`
  (after build).
- `tsconfig.json` — no change expected. `src/watcher.ts` is ESM
  (`import chokidar from 'chokidar'`), same as existing modules.

</code_context>

<specifics>

## Specific Ideas

- **Port 7331** is intentional (looks like `leet` — small inside joke in
  REQUIREMENTS.md). Honor it. Configurable via `--port` for dev override.
- **`chokidar` v4** is ESM-only. Compatible with the project's
  `"type": "module"` in package.json. No `__dirname` shenanigans.
- **Smoke test runs last** in vitest (alphabetical: `s` > others). This
  gives a clean "all green including e2e" final line.
- **No new env vars.** `OPENAI_API_KEY` already handled by phase 2
  repair. Phase 3 reads nothing from env except what's already plumbed.

No specific UI/UX requirements — the only "user" of phase 3 is a CLI
harness (Claude Code, raw terminal, curl).

</specifics>

<deferred>

## Deferred Ideas

- Multi-port serve (gRPC, stdio IPC for native Claude Code integration) —
  HTTP only in v1.
- File system events on `.ctx.db` itself (re-index if DB deleted
  mid-watch) — out of scope, document as known limitation.
- Auto-run `ctx repair` on watcher debounce flush — explicitly excluded
  by D-04. Revisit if user feedback requests.
- Watcher config file (`.ctx-watch.toml` with custom ignore patterns) —
  CLI flags only in v1.
- WebSocket for serve (streaming) — HTTP request/response only in v1.
- Plugin system for adapters (vscode, cursor, aider) — `claude-code`
  adapter only in v1. Others are separate phases.
- `ctx reflect <tool>` as a first-class command (currently it would
  read JSON from stdin or `--file` flag and pipe into `recordSignal`).
  Mentioned in D-XX but not committed. **Implementation optional** —
  leave the CLI subcommand out if not required by ROADMAP criteria.
  If included, it does NOT call any LLM; it just records signals.

None of these block phase 3. None of them belong in a different phase
right now — they'd be phase 4+ candidates.

</deferred>

---

*Phase: 3-Watcher + Adapter + CLI + Tests*
*Context gathered: 2026-07-26*
