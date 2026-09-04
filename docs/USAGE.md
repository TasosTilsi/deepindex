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

`deepindex index` walks the repo, parses supported files via tree-sitter, and populates the SQLite store. Re-running skips unchanged files (hash-based invalidation).

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
# Retrieve top-K files for a task
deepindex retrieve "how does auth work" --top-k 5

# Health report (JSON)
deepindex health <repo>

# Run the 4-stage repair pipeline
deepindex repair <repo>
```

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
| Claude Code | `.claude/settings.json` — MCP server + 4 hooks (SessionStart, UserPromptSubmit, PostToolUse, SessionEnd) |
| Codex | `.codex/hooks.json` (4 hooks) + `.codex/config.toml` (MCP) |
| OpenCode | `.opencode/plugins/deepindex/index.ts` (event-based plugin) |
| DeepSeek Harness | `~/.dsh/cordis.patch.yml` — `dsh-mcp-client` entry |

## Watcher

```bash
# Watch files and invalidate the summary cache on change
deepindex watch --debounce 250
```

## Configuration

Health thresholds are configurable via a `.deepindex.toml` file in the repo root:

```toml
[health]
repair_below = 80
```

LLM enrichment (repair fallback, batch extraction) is gated behind an `llm.enabled` config — never required.
