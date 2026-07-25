# Phase 1: Foundation — Graph + Fingerprint + Cache

**Goal**: Build the persistent state layer. After this phase, the framework can index a repo, hash files, store context, and read it back. No LLM, no health checks, no CLI commands beyond a minimal `ctx build`.

**Requirements**: GRPH-01..04, FNGR-01..02, CACH-01..02
**Success Criteria** (from ROADMAP.md):
1. `ctx build <repo>` walks a TS/JS/Python repo, parses files via tree-sitter, populates SQLite with files/symbols/imports/edges tables. Exits 0.
2. Re-running `ctx build` skips files whose hash hasn't changed. Verified by timing second run < first run on a 50+ file repo.
3. `getDependents(symbolId)` and `getDependencies(symbolId)` return correct BFS results on a fixture with known graph shape.
4. Cache stores arbitrary context objects keyed by hash. Re-storing same content is a no-op (hash match). Re-storing mutated content writes new version.
5. Fingerprint module returns `{hash, version, confidence, size, updatedAt}` for any context object. Stable across runs.

---

## Task List

### Task 1.1: Project init + CLI scaffold
**Files**: `package.json`, `tsconfig.json`, `.gitignore`, `src/cli.ts`, `src/index.ts`
**Output**: `pnpm install && pnpm build && pnpm run ctx --version` exits 0.

Commit: `chore: init package + tsconfig + commander CLI scaffold`

**Acceptance**:
- `package.json` declares ESM, Node 20+, deps: better-sqlite3, tree-sitter, tree-sitter-typescript, tree-sitter-javascript, commander, vitest, typescript, @types/node, @types/better-sqlite3
- `tsconfig.json` strict mode, ESNext, NodeNext modules
- `src/cli.ts` uses commander; `ctx build <repo>` is the only real command (stub for now)
- `pnpm test` works (zero tests is fine for this task)

---

### Task 1.2: SQLite schema + migration
**Files**: `src/graph/db.ts`, `src/graph/schema.sql`
**Output**: `initDb(path)` opens SQLite, applies schema, idempotent.

Commit: `feat(graph): SQLite schema for files, symbols, imports, edges`

**Schema**:
```sql
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  language TEXT,
  parsed_at INTEGER
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,        -- function, class, const, type, interface
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL  -- 0/1
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,      -- the import path as written
  resolved_file_id INTEGER REFERENCES files(id),
  resolved INTEGER NOT NULL  -- 0/1
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL         -- imports, calls, extends
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol_id);
```

**Acceptance**:
- `initDb` runs `CREATE TABLE IF NOT EXISTS` on every call. Idempotent.
- Schema versioned: `PRAGMA user_version` bumped on migration.

---

### Task 1.3: File walker + hasher
**Files**: `src/graph/walk.ts`, `src/graph/hash.ts`
**Output**: `walkRepo(root)` returns `[{path, mtime, size}]` honoring `.gitignore`. `hashContent(buf)` returns sha256.

Commit: `feat(graph): file walker + sha256 hasher`

**Acceptance**:
- `walkRepo(fixtures/sample-repo)` returns expected file list.
- Honors `.gitignore` by default. `--no-ignore` flag opt-in (later).
- `hashContent` is sha256 hex, 64 chars.

---

### Task 1.4: tree-sitter parser
**Files**: `src/graph/parse.ts`
**Output**: `parseFile(path, content)` returns `[{name, kind, startLine, endLine, exported}]`.

Commit: `feat(graph): tree-sitter parser for ts/js (python stub)`

**Approach**:
- Map file extension → language → parser:
  - `.ts`, `.tsx` → tree-sitter-typescript
  - `.js`, `.jsx`, `.mjs`, `.cjs` → tree-sitter-javascript
  - `.py` → stub for now (return empty), tree-sitter-python in v2
- Extract:
  - `export_statement` → exported symbol
  - `function_declaration`, `class_declaration`, `interface_declaration`, `type_alias_declaration`, `lexical_declaration` (with const/let) → symbols
- Use tree-sitter `query` API for performance. No raw cursor walks.

**Acceptance**:
- Parses a TS file with 5 exports → returns 5 symbols with correct names and line ranges.
- Returns `[]` for unsupported extensions (no throw).

---

### Task 1.5: Import resolver
**Files**: `src/graph/resolve.ts`
**Output**: `resolveImport(fromFile, importSource, repoRoot)` returns target file path or null.

Commit: `feat(graph): relative import resolver`

**Approach**:
- Strip leading `./` and `../` from import source.
- Try extensions in order: `.ts`, `.tsx`, `.js`, `.jsx`, `/index.ts`, `/index.js`.
- If file exists in repo → return path. Else null.

**Acceptance**:
- `resolve('./foo', 'src/a.ts')` → `src/foo.ts` if exists.
- `resolve('../bar', 'src/sub/a.ts')` → `src/bar.ts` if exists.
- `resolve('lodash', 'src/a.ts')` → null (external).

---

### Task 1.6: Graph builder (orchestrates parse + resolve + insert)
**Files**: `src/graph/build.ts`
**Output**: `buildGraph(repoRoot)` indexes all files, populates DB. Skips unchanged files by hash.

Commit: `feat(graph): buildGraph with hash-based incremental indexing`

**Approach**:
- Walk repo.
- For each file: hash content. If hash matches existing DB row → skip parse.
- Else: parse, extract symbols, insert file row + symbol rows.
- For each import in file: resolve to file path. If resolved → mark resolved=1, link to file. If not → mark resolved=0, leave resolved_file_id null.
- Build edges: for each import that resolved, find all symbols in target file, create edge from a placeholder "module" symbol of source file → each exported symbol of target. (Simpler than per-symbol import resolution, still gives useful BFS.)

**Acceptance**:
- First `buildGraph` parses all files, populates tables.
- Second `buildGraph` with no changes: zero file re-parses, all file hashes match existing rows.
- Fixture with broken import: import row marked resolved=0.

---

### Task 1.7: BFS queries
**Files**: `src/graph/query.ts`
**Output**: `getDependents(symbolId, depth)`, `getDependencies(symbolId, depth)`, `getSymbolByName(name)`.

Commit: `feat(graph): BFS dependents/dependencies queries`

**Acceptance**:
- `getDependencies(symbolId, 0)` returns direct deps.
- `getDependencies(symbolId, 2)` returns transitive up to depth 2.
- `getDependents` is symmetric.
- Uses SQL recursive CTE for performance.

---

### Task 1.8: Fingerprint module
**Files**: `src/fingerprint.ts`
**Output**: `fingerprint(content, signals?)` returns `{hash, version, confidence, size, updatedAt}`.

Commit: `feat(fingerprint): {hash, version, confidence, size, updatedAt} per context object`

**Approach**:
- `hash` = sha256 of content.
- `version` = monotonic counter from DB (per cache key, see Task 1.9).
- `confidence` = derived from `signals`:
  - `signals.hashStable` (default true) → 0.4 weight
  - `signals.importsResolved` (0-1) → 0.3 weight
  - `signals.testsPass` (0-1) → 0.3 weight
  - Returns weighted sum, 0-1.
- `size` = bytes.
- `updatedAt` = now ISO.

**Acceptance**:
- Same content → same hash. Different content → different hash.
- Confidence of 0.0 signals → confidence field = 0. Confidence of all-1 → 1.0.
- `updatedAt` is parseable ISO date.

---

### Task 1.9: Context cache (hash-keyed, LRU)
**Files**: `src/cache.ts`
**Output**: `cacheSet(key, content, fingerprint)`, `cacheGet(key)`, `cacheDelete(key)`.

Commit: `feat(cache): hash-keyed context store with LRU eviction`

**Schema additions**:
```sql
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  confidence REAL NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
```

**Approach**:
- `cacheSet`: write row. Update LRU (last_access = now). If total size > 100MB → evict oldest by last_access until under cap. Log evictions.
- `cacheGet`: read row, update last_access, return content + fingerprint.
- `cacheDelete`: remove row.

**Acceptance**:
- `set(k, c1)` then `set(k, c1)` → version increments, same hash.
- `set(k, c1)` then `set(k, c2)` → new version, new hash.
- `get(k)` returns latest content + fingerprint.
- LRU: set 200MB worth of content with cap 100MB → oldest evicted, log line emitted.

---

### Task 1.10: Wire `ctx build` end-to-end
**Files**: `src/cli.ts`, `src/index.ts`
**Output**: `pnpm run ctx build <repo>` builds graph, prints "indexed N files, M symbols".

Commit: `feat(cli): ctx build walks repo, builds graph, prints stats`

**Acceptance**:
- `ctx build fixtures/sample-repo` exits 0, prints stats.
- DB file created at `.planning/index.db` (or `ctx.db` in repo root).
- No LLM calls.

---

### Task 1.11: Tests + sample fixture
**Files**: `tests/graph.test.ts`, `tests/cache.test.ts`, `tests/fingerprint.test.ts`, `fixtures/sample-repo/`

Commit: `test: graph + cache + fingerprint unit tests + sample fixture`

**Sample fixture** (3-4 files):
- `fixtures/sample-repo/src/a.ts` exports `foo`, imports `./b`
- `fixtures/sample-repo/src/b.ts` exports `bar`, imports `./c`
- `fixtures/sample-repo/src/c.ts` exports `baz`, imports `./missing` (broken)
- `fixtures/sample-repo/src/missing.ts` deliberately absent

**Tests**:
- `graph.test.ts`: parse fixture, assert file count, symbol count, broken import count, BFS from `foo` reaches `bar` (depth 2).
- `cache.test.ts`: set/get, LRU eviction, hash match no-op.
- `fingerprint.test.ts`: hash stable, confidence math, updatedAt parseable.

**Acceptance**:
- `pnpm test` green.
- `pnpm run ctx build fixtures/sample-repo && pnpm run ctx build fixtures/sample-repo` — second run < 100ms (skips all).

---

## Goal-Backward Check

| Success Criterion | Task | Verification |
|--------------------|------|--------------|
| 1. `ctx build` populates SQLite | 1.2, 1.6, 1.10 | `pnpm run ctx build fixtures/sample-repo` exits 0, DB has rows |
| 2. Re-run skips unchanged | 1.3, 1.6 | Time second run, assert < 100ms |
| 3. BFS correct | 1.7, 1.11 | `tests/graph.test.ts` asserts `foo → bar` via BFS |
| 4. Cache works | 1.9, 1.11 | `tests/cache.test.ts` covers set/get/LRU |
| 5. Fingerprint stable | 1.8, 1.11 | `tests/fingerprint.test.ts` covers all fields |

All 5 criteria covered. No gap.

---

## Atomic Commits (summary)

1. `chore: init package + tsconfig + commander CLI scaffold`
2. `feat(graph): SQLite schema for files, symbols, imports, edges`
3. `feat(graph): file walker + sha256 hasher`
4. `feat(graph): tree-sitter parser for ts/js (python stub)`
5. `feat(graph): relative import resolver`
6. `feat(graph): buildGraph with hash-based incremental indexing`
7. `feat(graph): BFS dependents/dependencies queries`
8. `feat(fingerprint): {hash, version, confidence, size, updatedAt} per context object`
9. `feat(cache): hash-keyed context store with LRU eviction`
10. `feat(cli): ctx build walks repo, builds graph, prints stats`
11. `test: graph + cache + fingerprint unit tests + sample fixture`

---

## Risks & Mitigations

- **Risk**: tree-sitter-typescript API surface in JS differs from docs. → Mitigation: use query API only, no raw cursor walks. Fallback to simpler regex-based extract if query fails.
- **Risk**: better-sqlite3 native build on user's machine. → Mitigation: include `@types/better-sqlite3`, document `node-gyp` prereqs in README, fall back to in-memory `:memory:` for tests.
- **Risk**: BFS performance on large repos. → Mitigation: SQL recursive CTE + indexed edges. Add EXPLAIN QUERY PLAN check in tests.

## Out of Scope (deferred to Phase 2/3)

- Python parsing (stub for now)
- Import alias resolution (`import { x as y }`)
- Re-exports (`export { foo } from './bar'`)
- Symbol-level import edges (currently file-level)
- Type-only imports filtering
