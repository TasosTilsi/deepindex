# DeepIndex Usage

## Installation

```bash
npm install -g deepindex
# or
pnpm add -g deepindex
```

The `deepindex` binary is the CLI. It reads/writes a single SQLite database (default `.deepindex.db` in the current directory).

## Indexing

```bash
# Index a repository (parse files, build the symbol/import graph)
deepindex index <repo>

# Force a full re-parse (bypass hash cache)
deepindex index <repo> --rebuild
```

`deepindex index` walks the repo, parses supported files via tree-sitter, and populates the SQLite store. Re-running skips unchanged files (hash-based invalidation). **It also indexes git history** into the knowledge graph (entities + backlinks) in the same pass.

**Supported languages (32):** TypeScript, JavaScript, Python, Java, C, C++, Go, Rust, PHP, Ruby, C#, Swift, Kotlin, Scala, Bash, Dart, Lua, Elixir, Objective-C, HTML, CSS, JSON, YAML, Markdown, Vue, Svelte, Perl, R, Haskell, Clojure, Erlang, Zig.

## Git-History Knowledge Graph

```bash
# Walk full git history, extract typed entities (deterministic by default)
deepindex git-index <repo>

# Incrementally sync commits since the last index
deepindex git-sync <repo>

# Force a full reindex
deepindex git-sync <repo> --full

# Search the knowledge graph (FTS5)
deepindex search "auth"
```

Entities are typed: `decision`, `bug_fix`, `pattern`, `tech_debt`, `concept`, `breaking_change`, `security_fix`, `workflow`. They have bidirectional backlinks with typed relationships (`fixes`, `implements`, `depends_on`, `relates_to`, `breaks`).

## Retrieval & Health

```bash
# Retrieve top-K files for a task (auto git-syncs first)
deepindex retrieve "how does auth work" --top-k 5

# Health report (JSON)
deepindex health <repo>

# Run the 4-stage repair pipeline
deepindex repair <repo>
```

`deepindex retrieve` and `deepindex search` run an **incremental git-sync** (from the last indexed commit) before querying, so entities are always current.

### Retrieval tips

`retrieve` matches queries against **file paths and symbol names** (exact + substring, case-insensitive) and ranks by TF-IDF + graph proximity. Phrase queries with both a concept and a likely identifier/path term:

```bash
# Path term recovers a symbol-free config file
deepindex retrieve "persistence application.properties"

# Identifier term finds the domain type even from a concept-heavy query
deepindex retrieve "monetary amount Money"
```

Plural/singular variants are probed automatically — `validations` also matches `validation`. Near-synonym phrasing that shares no vocabulary with paths or symbols (e.g. "cash value object" for `Money`) needs semantic mode; see [Semantic mode](#semantic-mode).

## Measured token savings

Measured on THIS repository (169 indexed files, 1,788 symbols; 140 tracked code+docs files, ~674 KB), against a fresh `deepindex index` of the repo, over five pre-declared representative queries:

| Context strategy (per task) | Avg tokens | vs DeepIndex |
|---|---|---|
| Whole-repo dump (read all tracked code+docs) | ~168,500 | 12.6× more |
| Grep-fallback (grep query terms, read every matched file) | ~90,900 (28–83 matched files/query) | 6.8× more |
| `deepindex retrieve --json --top-k 10` (output alone) | ~6,200 | — |
| **retrieve + read the top-3 files it points to (realistic agent usage)** | **~13,400** | **baseline** |

**Headline: ~85% fewer context tokens per task than the grep-fallback workflow (~92% vs dumping the whole repo).** Per-query range vs grep-fallback: 72%–96%.

Method: token counts are bytes/4 (ASCII-dominant source heuristic — not a model-specific tokenizer; exact byte counts were verified alongside). Grep-fallback = `git grep -il` over stopword-filtered query terms, every matched file read fully. Protocol: index the repo, `deepindex retrieve <query> --top-k 10 --json`, sum the output plus the top-3 pointed files; compare against the grep-matched file set and the whole-repo dump.

Caveats — read before quoting these numbers:

- The sample queries follow the recommended phrasing (concept + identifier/path term — see [Retrieval tips](#retrieval-tips)). Cross-vocabulary phrasing is weaker lexically: the on-record A/B measured 3/5 precision on a 7-file Java demo (`docs/ISSUES.md` DI-08); near-synonym phrasing needs semantic mode.
- Savings are only useful if the retrieval is relevant: hits were 7–10 files/query here; a total miss returns nothing and the agent falls back to grep — which then costs MORE overall.
- Single-repo sample (~170 files). Whether the gap widens on larger repos is plausible but unmeasured — needs-a-run on a bigger codebase before claiming it.

## Semantic mode

```bash
# Explicit opt-in bootstrap — downloads the embedding model (the ONLY network path)
deepindex embed --fetch-model

# Enable per repo (.deepindex.toml)
[semantic]
enabled = true
# model = bge   # optional: Xenova/bge-small-en-v1.5 (default: minilm)
```

- **Dependency**: `@huggingface/transformers` ships as an `optionalDependency` — installed by default, so pinned `npx -y deepindex@<version>` consumers get the vector layer. Escape hatch: `npm i --omit=optional` / `pnpm i --no-optional`. Without it every semantic feature degrades to a warning + lexical fallback — never a crash.
- **Model**: `Xenova/all-MiniLM-L6-v2` (Apache-2.0, [huggingface.co/Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)) — 384-dim MiniLM; `Xenova/bge-small-en-v1.5` is selectable. Inference is local-only — code snippets never leave the machine; only the one-time model fetch touches the network.
- **Reproducibility pin**: the model revision is pinned per release (commit sha recorded in `MODEL_CONFIGS` in the source) and passed to every pipeline fetch/load — two machines running the same deepindex version fetch identical weights. A cached model fetched under a different revision triggers a stderr warning on load; re-run `deepindex embed --fetch-model` to re-pin.
- **Supply chain**: fetched LFS weight files are sha256-verified against the HuggingFace tree listing at fetch time; the verified digests + revision are recorded in `<cache>/<model>/.deepindex-model.json`. NOTE for audit tooling: the weights arrive via this explicit out-of-band download and are NOT visible to CycloneDX / osv-scanner SBOMs — account for the artifact via the marker file. Cache location: `~/.deepindex/models` (override: `DEEPINDEX_MODEL_CACHE_DIR`).

## Data-Flow & Requirements

```bash
# List discovered database tables
deepindex list-tables

# Find code reading/writing a table
deepindex find-table-usage <table>

# Impact analysis (Table -> Query -> File -> Service)
deepindex analyze-impact <table>

# Parallel-storage detection
deepindex check-parallel-storage

# Sync requirements from a JSON file
deepindex sync-requirements <file>

# Requirements coverage report
deepindex check-req-coverage
```

## Advanced Commands

The following commands are hidden from `deepindex --help` (they're niche or internal), but remain functional. Run `deepindex <command> --help` for each one's full usage.

### Data-flow analysis

| Command | Purpose |
|---------|---------|
| `deepindex build-graph` | Build + validate the data-flow projection (Table↔Query↔Service). |
| `deepindex list-tables` | List every discovered database table/collection (from SQL, ORM, config mappings). |
| `deepindex find-table-usage <table>` | Find code that reads/writes a specific table. |
| `deepindex summarize-graph` | Print a summary of the SQL-impact projection (table/query/service counts). |
| `deepindex analyze-impact <table>` | Impact chain: which queries/files/services touch a table. `--domain/--region/--system` filter by context tags. |
| `deepindex check-parallel-storage` | Flag tables stored in more than one storage system (e.g. DB2 + MongoDB). `--domain/--region/--system` filters supported. |

### Requirements traceability

| Command | Purpose |
|---------|---------|
| `deepindex sync-requirements <file>` | Index requirements from a JSON file. |
| `deepindex check-req-coverage` | Report requirements without code and code without requirements (uses `@req` annotations). |

### Internal (automatic)

| Command | Purpose |
|---------|---------|
| `deepindex git-index <repo>` | Walk full git history into the knowledge graph. **Automatic** — run inside `deepindex index`. Only needed for manual full re-index. |
| `deepindex git-sync <repo>` | Incrementally sync commits since the last index. **Automatic** — run before `search`/`retrieve`. `--full` forces a full re-index. |
| `deepindex hook <name>` | Claude Code / Codex / OpenCode hook entry points. **Called by the harness** — not for manual use. |

## HTTP Server & Dashboard

```bash
# Start the server (POST /context + GET /api/* + GET / dashboard)
deepindex serve --port 7331
```

`deepindex serve` reads the **project registry** (`~/.deepindex/projects.json`) and serves a **multi-project dashboard** on localhost. Every `deepindex index <repo>` registers the project, so the dashboard shows all indexed projects with a project selector.

```bash
# Dashboard API
curl http://127.0.0.1:7331/api/projects          # list all projects
curl http://127.0.0.1:7331/api/overview          # default project
curl http://127.0.0.1:7331/api/overview?project=myrepo   # specific project
curl http://127.0.0.1:7331/api/entities?project=myrepo
curl http://127.0.0.1:7331/api/dataflow?project=myrepo
curl "http://127.0.0.1:7331/api/search?q=auth&project=myrepo"
curl http://127.0.0.1:7331/api/symbols?project=myrepo
```

Open `http://127.0.0.1:7331/` in a browser for the read-only dashboard (Overview, Knowledge Graph, Data Flow, Search, Symbols) with a project selector in the nav.

## MCP Server

```bash
# Start the MCP server (stdio)
deepindex mcp serve

# Install MCP + hooks into a harness
deepindex mcp install
```

The MCP server exposes 6 read-only tools: `search_knowledge`, `get_entity`, `get_backlinks`, `get_decisions`, `get_bugs`, `get_patterns`. All logging goes to stderr (stdout is the protocol).

## Harness Integration

```bash
# Interactive install — choose harness(es)
deepindex install

# Or install for a specific harness
deepindex install --harness claude-code
deepindex install --harness codex
deepindex install --harness opencode
deepindex install --harness deepseek-harness
```

| Harness | What's installed |
|---------|------------------|
| Claude Code | root `.mcp.json` — MCP server + `.claude/settings.json` — 4 hooks (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd) |
| Codex | `.codex/hooks.json` (4 hooks) + `.codex/config.toml` (MCP) |
| OpenCode | root `opencode.json` — `mcp.deepindex` entry + `.opencode/plugins/deepindex/index.ts` (event plugin) |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml` — `dsh-mcp-client` entry |

Every generated command is pinned `npx -y deepindex@<version>` (version read from package.json at install time) — safe for pinned-npx consumers; a bare `deepindex` command would assume a global install.

## Watcher

```bash
# Watch files and invalidate the summary cache on change
deepindex watch --debounce 250
```

## Exit codes & preconditions

| Verb | 0 | 1 | 2 |
|------|---|---|---|
| `index <repo>` | indexed (warnings may appear on stderr) | parse/build error | repo path not found |
| `health <repo>` | score ≥ `repair_below` | score **below** `repair_below` | **no index** (`--db` file missing) or repo path not found |
| `retrieve <query>` | results printed (possibly none) | query error | no index, or invalid `--top-k` |
| `search <query>` | results printed (possibly none) | query error | no index, or invalid `--limit`/`--mode` |
| `embed [repo]` | embedded — **or semantic layer unavailable** (deliberate: a missing optional dependency is a warning + lexical fallback, never a failure) | other errors | repo path not found / no index |
| `git-index` / `git-sync <repo>` | synced | sync error | repo path not found |
| `mcp serve` | runs until stdin closes | server error | no index |
| `install` | installed | — | unknown harness |

**Preconditions:** `index` accepts any existing directory — git history is optional. Outside a git repo the knowledge-graph layer is skipped with a loud stderr warning (`not a git repository — knowledge-graph layer skipped`); the symbol/import graph is still fully built, and `git-sync`/`search`/MCP entity tools will be empty for that repo. The `health` 1-vs-2 distinction: 1 means the index exists but scored below `repair_below` (run `deepindex repair`); 2 means there is nothing to score yet (run `deepindex index <repo>`).

## Configuration

Health thresholds are configurable via a `.deepindex.toml` file in the repo root:

```toml
[health]
repair_below = 80
```

LLM enrichment (repair fallback, batch extraction) is gated behind an `llm.enabled` config — never required.
