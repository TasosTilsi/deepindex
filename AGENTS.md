<!-- Generated: 2026-08-11 | Updated: 2026-08-11 -->

# deepindex

## Purpose
Self-healing, token-efficient context engineering framework for AI coding harnesses. Indexes a repository into a SQLite-backed knowledge store (symbol/import graph + data-flow graph + git-history knowledge graph), scores index health, retrieves relevant context for a task, and repairs degradation through a deterministic-then-LLM pipeline. Ships a `deepindex` CLI, a POST `/context` HTTP server, a chokidar watcher, a pure-function adapter, an MCP server, harness hooks (Claude Code / Codex / OpenCode / DeepSeek Harness), and a multi-project web dashboard. Deterministic-first, LLM-optional, local-first (no SaaS, no API key).

## Key Files
| File | Description |
|------|-------------|
| `package.json` | Manifest; package name `deepindex`, bin `deepindex`, deps (better-sqlite3, chokidar, commander, web-tree-sitter, @modelcontextprotocol/sdk, js-yaml, zod) |
| `tsconfig.json` | Strict NodeNext TS build; rootDir `src`, outDir `dist`, declarations + sourcemaps |
| `vitest.config.ts` | Vitest config; runs `tests/**/*.test.ts` in node env; CI=1 enables v8 coverage gate |
| `pnpm-workspace.yaml` | pnpm workspace definition |
| `.gitignore` | Ignored paths (node_modules, dist, *.db, tooling dirs) |
| `dashboard/` | React + Vite web dashboard (5 views, taste-skill minimalist design) |
| `docs/` | README, USAGE, DESIGN, ADRs |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Framework source — graph, cache, health, retrieve, repair, reflect, watcher, serve, adapter, git, mcp, hooks, install, registry, dashboard (see `src/AGENTS.md`) |
| `src/git/` | Git-history knowledge graph — walker, extract, indexer, search, sanitize |
| `src/mcp/` | MCP server (stdio, 6 read-only tools) + additive install |
| `src/hooks/` | 4 Claude Code hooks (session-start, user-prompt-submit, post-tool-use, session-end) |
| `src/dashboard/` | Read-only dashboard API endpoints |
| `tests/` | Vitest unit suites, one per src module (see `tests/AGENTS.md`) |
| `scripts/` | Standalone self-check scripts (see `scripts/AGENTS.md`) |
| `fixtures/` | Sample repos used by tests and self-checks (see `fixtures/AGENTS.md`) |
| `skills/taste-skill/` | Vendored design skills (taste-skill minimalist) for the dashboard |

## For AI Agents

### Working In This Directory
- ESM-only, NodeNext resolution — imports must carry `.js` extension (e.g. `import { x } from './cache.js'`).
- Do not touch `.omc/`, `.planning/`, `.serena/`, `.claude/`, `.opencode/`, `.windsurf/`, `.scratch/` — tooling state, not source.
- `.tree-sitter/` holds the 32 grammar `.wasm` files — needed at runtime, committed. Do not remove.
- The framework is phase-structured (phases 1-7 complete, v2.0 merge milestone). Keep new work in the matching module.
- Default DB is `.deepindex.db`; config file is `.deepindex.toml`.

### Testing Requirements
- `pnpm test` — vitest run (all suites must pass before commit).
- `pnpm build` — tsc; must typecheck clean.
- `pnpm smoke` — end-to-end self-check on the fixture repo.
- Verify gate: `pnpm exec tsc --noEmit && pnpm test && CI=1 pnpm test` — all three green before commit.
- `CI=1 pnpm test` enables the v8 coverage gate (≥70% lines on `src/`, excludes `src/types.ts`); plain `pnpm test` skips coverage.
- `tests/smoke.test.ts` is a plain tsx script (run via `pnpm run smoke`), excluded from vitest — not a test suite.
- Note: `CI=1 pnpm test` may fail on a pnpm store-index issue; bypass with `pnpm --config.verify-deps-before-run=false exec vitest run`.

### Common Patterns
- Pure functions of `db: Database.Database` + options — no module-level singletons except `initDb`'s internal `_db`.
- Type aliases/interfaces for results live in `src/types.ts`.
- Prepared statements created once, reused per call.
- Error messages prefixed with function name (`cacheDelete: ...`).
- Git tests build a fixture repo in a temp dir via `tests/helpers/git-fixture.ts` (a committed fixture can't carry a real `.git` history).

## Dependencies

### Internal
- `src/` modules cross-import via `./x.js` relative paths; public surface re-exported from `src/index.ts`.
- `src/git/search.ts` (FTS5) + `src/graph/projection.ts` (data-flow) feed the MCP tools and dashboard API.

### External
- better-sqlite3 — SQLite storage (WAL mode, schema v5)
- web-tree-sitter — 32-language parsing (grammars in `.tree-sitter/`)
- chokidar — file watching
- commander — CLI parsing
- @modelcontextprotocol/sdk — MCP server
- js-yaml — DSH config parsing
- zod — MCP tool schemas
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
