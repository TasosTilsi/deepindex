<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# deepindex

## Purpose
Self-healing, token-efficient context engineering framework for AI coding harnesses. Indexes a repository into a SQLite-backed symbol/import graph, scores index health, retrieves relevant files for a query, and repairs degradation through a deterministic-then-LLM pipeline. Ships a `ctx` CLI, a POST `/context` HTTP server, a chokidar-based cache-invalidation watcher, and a pure-function adapter for Claude Code.

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Manifest; package name `deepindex`, bin `ctx`, deps (better-sqlite3, chokidar, commander, web-tree-sitter) |
| `tsconfig.json` | Strict NodeNext TS build; rootDir `src`, outDir `dist`, declarations + sourcemaps |
| `vitest.config.ts` | Vitest config; runs `tests/**/*.test.ts` in node env |
| `pnpm-workspace.yaml` | pnpm workspace definition |
| `.npmrc` | pnpm configuration |
| `.gitignore` | Ignored paths |
| `context-engineering-article.txt` | Scratch article text (untracked, not part of build) |
| `test.ts` | Scratch test file (untracked, not part of build) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Framework source — graph, cache, health, retrieve, repair, reflect, watcher, serve, adapter (see `src/AGENTS.md`) |
| `tests/` | Vitest unit suites, one per src module (see `tests/AGENTS.md`) |
| `scripts/` | Standalone self-check scripts (see `scripts/AGENTS.md`) |
| `fixtures/` | Sample repos used by tests and self-checks (see `fixtures/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- ESM-only, NodeNext resolution — imports must carry `.js` extension (e.g. `import { x } from './cache.js'`).
- Do not touch `.omc/`, `.planning/`, `.tree-sitter/`, `.serena/`, `.claude/` — tooling state, not source.
- The framework is phase-structured (phase 2: health/retrieve/repair/reflect; phase 3: watcher/serve/adapter/CLI); keep new work in the matching module.

### Testing Requirements
- `pnpm test` — vitest run (all suites must pass before commit).
- `pnpm build` — tsc; must typecheck clean.
- `pnpm smoke` — phase-2 end-to-end self-check on the fixture repo.
- Verify gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test` — all three green before commit.
- `CI=1 pnpm test` enables the v8 coverage gate (≥70% lines on `src/`, excludes `src/types.ts`); plain `pnpm test` skips coverage.
- `tests/smoke.test.ts` is a plain tsx script (run via `pnpm run smoke`), excluded from vitest — not a test suite.

### Common Patterns
- Pure functions of `db: Database.Database` + options — no module-level singletons except `initDb`'s internal `_db`.
- Type aliases/interfaces for results live in `src/types.ts`.
- Prepared statements created once, reused per call.
- Error messages prefixed with function name (`cacheDelete: ...`).

## Dependencies

### Internal
- `src/` modules cross-import via `./x.js` relative paths; public surface re-exported from `src/index.ts`.

### External
- better-sqlite3 — SQLite storage (WAL mode)
- web-tree-sitter — TS/JS parsing
- chokidar — file watching
- commander — CLI parsing
- vitest + tsx + typescript — test/build toolchain

<!-- MANUAL: -->

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop: articles (a/an/the), filler (just/really/basically), pleasantries, hedging
- Fragments OK. Short synonyms. Technical terms exact. Code unchanged.
- Pattern: [thing] [action] [reason]. [next step].
- Not: "Sure! I'd be happy to help you with that."
- Yes: "Bug in auth middleware. Fix:"

Switch level: /caveman lite|full|ultra|wenyan
Stop: "stop caveman" or "normal mode"

Auto-Clarity: drop caveman for security warnings, irreversible actions, user confused. Resume after.

Boundaries: code/commits/PRs written normal.
