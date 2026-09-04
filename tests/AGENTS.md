<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# tests

## Purpose
Vitest unit suites. One test file per src module, exercising parse/build/query, cache/fingerprint, health/retrieve/repair/reflect, and the phase-3 watcher, adapter, and CLI against in-memory or temp-file SQLite databases and `fixtures/sample-repo`.

## Key Files
| File | Description |
|------|-------------|
| `graph.test.ts` | Graph subsystem: build stats, symbols/imports/edges, resolution, BFS |
| `cache.test.ts` | cacheSet/Get/Delete/Stats, version bumping, eviction |
| `fingerprint.test.ts` | sha256 + fingerprint confidence computation |
| `health.test.ts` | getHealth scoring, signals, `.deepindex.toml` config loader |
| `retrieve.test.ts` | tokenize/tfidf + full retrieve ranking against fixture |
| `repair.test.ts` | 4-stage pipeline, git-history contradiction detection, LLM stage caching |
| `reflect.test.ts` | vitest/eslint/istanbul JSON parsers incl. malformed input |
| `watcher.test.ts` | chokidar watcher: debounce, cache invalidation, close |
| `adapter.test.ts` | adaptClaudeCode JSON shape (topFiles/neighborhood/health) |
| `cli.test.ts` | CLI commands and exit codes on fixture repo |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Tests import from `../src/...` with `.js` extension (NodeNext).
- Fixture repo lives at `fixtures/sample-repo` — keep it in sync if its files change (graph/retrieve/repair tests depend on its shape: `a.ts → b.ts → c.ts` import chain, broken import, `// CLAIM:` doc).
- Prefer temp dirs / in-memory SQLite over committing `.db` files; never write DBs into the repo tree.
- CLI tests run the built behavior through `tsx src/cli.ts` or spawn the CLI — assert on exit codes and stdout.

### Testing Requirements
- `pnpm test` — all suites green.
- Any src behavior change must carry a matching test update in this directory.

### Common Patterns
- `beforeEach`/`afterEach` creating and closing a fresh `initDb` per test.
- Fixture path resolved via `resolve(process.cwd(), 'fixtures/sample-repo')`.

## Dependencies

### Internal
- `../src/**` — every module under test
- `../fixtures/sample-repo` — canonical test repo

### External
- vitest

<!-- MANUAL: -->
