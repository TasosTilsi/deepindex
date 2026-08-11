<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# src

## Purpose
Framework source. Turns a repository into an indexed, queryable, self-repairing context store: a tree-sitter symbol/import graph persisted to SQLite, cached content with fingerprints, a health scorer, TF-IDF retrieval, a 4-stage repair pipeline, plus the phase-3 watcher, HTTP server, CLI, and Claude Code adapter.

## Key Files
| File | Description |
|------|-------------|
| `index.ts` | Public API barrel — re-exports every module's surface |
| `cli.ts` | `ctx` commander CLI: build, status, repair, retrieve, serve, watch |
| `types.ts` | Shared interfaces: File, Symbol, Import, Edge, Fingerprint, Health*, Retrieve*, Repair* |
| `graph/` | SQLite schema + parse/build/query/resolve (see `graph/AGENTS.md`) |
| `cache.ts` | Fingerprinted content cache with LRU-by-last-access eviction |
| `fingerprint.ts` | Content hashing (sha256) + confidence-weighted fingerprint |
| `health.ts` | Health scoring (freshness/consistency/coverage/confidence), signal store, `.ctx.toml` loader |
| `retrieve.ts` | Tokenize, TF-IDF, hybrid rank (0.6 tfidf + 0.4 graph proximity) |
| `repair.ts` | 4-stage pipeline: rebuild → cache invalidate → git-history probe → optional LLM |
| `reflect.ts` | Pure JSON parsers for vitest/eslint/istanbul-coverage output |
| `watcher.ts` | chokidar watcher; debounced `summary:` cache invalidation (no auto-repair) |
| `serve.ts` | Node-stdlib HTTP server, single POST /context route |
| `adapter-claude-code.ts` | Pure-function adapter returning the same JSON shape as the server |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `graph/` | Graph subsystem — DB schema, tree-sitter parsing, graph build, BFS query, import resolution (see `graph/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Imports must use `.js` extension under NodeNext (even for `.ts` files).
- Health/retrieve/repair/reflect are phase-2 "pure functions of db" — no env reads, no I/O beyond what the signature takes, no module-level singletons.
- `repair.ts` stage 3 invokes `git log` via `execFileSync`; keep that contained.
- Keep `index.ts` in sync when adding a public module.

### Testing Requirements
- Each module has a mirror test in `tests/<module>.test.ts` — add/update it with new behavior.
- Run `pnpm test`; watch for the phase-2 self-check `pnpm smoke` when touching health/retrieve/repair.

### Common Patterns
- Prepared statements compiled once at module scope, reused per call.
- `opts` objects with defaults (`?? DEFAULT_X`) rather than many positional params.
- Return-value types declared in `types.ts`; module-local helpers kept private.

## Dependencies

### Internal
- `graph/` — db, parse, build, query, resolve
- `cache.ts` ← used by watcher/repair; `fingerprint.ts` ← used by cache/repair

### External
- better-sqlite3, web-tree-sitter, chokidar, commander, node:http/crypto/fs/path/child_process

<!-- MANUAL: -->
