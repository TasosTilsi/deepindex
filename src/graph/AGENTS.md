<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-11 -->

# graph

## Purpose
Graph subsystem: SQLite schema and the parse/build/query pipeline that turns a repo's TS/JS files into `files`, `symbols`, `imports`, and `edges` tables, plus BFS traversal and import-path resolution used by retrieval and the adapter.

## Key Files
| File | Description |
|------|-------------|
| `db.ts` | `initDb`/`getDb`/`closeDb`; SQLite schema v3 (files, symbols, imports, edges, cache, health_signals, sql_queries, query_tables), WAL + foreign keys, module-level `_db` singleton |
| `parse.ts` | web-tree-sitter wrapper — parses TS/JS/multi-lang to symbols (functions/classes/interfaces/types/enums/consts) and imports; lazy parser init, WASM from `.tree-sitter/`; `EXT_TO_LANG` map for O(1) ext→lang |
| `build.ts` | `buildGraph`: walk repo (skip node_modules/.git/dist/etc), hash-diff to skip unchanged, parse changed files, resolve imports, build file-level `edges` approximation; owns `BuildStats`/`BuildOptions` types |
| `projection.ts` | `projectFullGraph` + `detectServiceName` — in-memory Table→Query→File→Service projection from `query_tables`/`sql_queries`/`files` |
| `symbol-graph.ts` | `getSymbolByName`, `getDependencies`/`getDependents` — shared BFS over `edges` up to depth N |
| `sql-impact.ts` | `getImpact`, `findParallelStorage` — SQL-impact tracing over the projected graph (used by `summarize-graph`/`analyze-impact`/`find-table-usage` CLI verbs) |
| `resolve.ts` | `resolveImport` — resolve relative imports (as-is, +ext, /index) against known files; bare modules return null |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- `parse.ts` requires tree-sitter WASM files under `.tree-sitter/` — do not move/remove them; `pnpm install` rebuilds per `pnpm.onlyBuiltDependencies`.
- `build.ts` deletes and rebuilds ALL `edges` on every build (file-level approximation); symbol-level edge resolution is a known simplification.
- `db.ts` schema changes must bump `SCHEMA_VERSION` and the `user_version` pragma migration.

### Testing Requirements
- `tests/graph.test.ts` covers parse/build/symbol-graph against `fixtures/sample-repo`.
- New symbol-graph helpers need coverage in `tests/graph.test.ts` (retrieval depends on `symbol-graph.ts` semantics); SQL-impact helpers go in `tests/graph-queries.test.ts`.

### Common Patterns
- SQL written inline in prepared statements; `ON CONFLICT ... DO UPDATE` upserts for file rows.
- File identity is the repo-relative path string (unique index on `files.path`).
- BFS uses `SELECT DISTINCT ... WHERE from/to_symbol_id IN (...)` per depth level.

## Dependencies

### Internal
- `../types.ts` — shared row types
- `../retrieve.ts` and `../adapter-claude-code.ts` consume `symbol-graph.ts` (getDependents/getDependencies)

### External
- better-sqlite3, web-tree-sitter

<!-- MANUAL: -->