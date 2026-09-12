# DeepIndex — Known Issues & Upstream Backlog

Findings from integrating DeepIndex into the [ai-ready-nx-workspace](https://github.com/codeaiforge/ai-ready-nx-workspace) governance framework (agent-agnostic Nx monorepo template). Ground truth: the published `deepindex@0.3.2` and `deepindex@0.3.3` npm tarballs plus live probes against them, re-checked against this checkout's `main` (0.3.4-dev). Recorded 2026-09-10/11.

Each item: severity, verified evidence, impact on downstream consumers, suggested fix, status.

## Issues — all closed in 0.3.4-dev

Fixes landed in this checkout (0.3.4-dev), each driven red→green: a failing test on record before the fix, a passing run after.

### DI-01 — `@huggingface/transformers` is not a published dependency (HIGH)

- **Evidence:** `src/semantic/embedder.ts` imports `@huggingface/transformers` at runtime (`importTransformers()`); `package.json` `dependencies`/`optionalDependencies` do not contain it (still true on 0.3.4-dev). `embed --fetch-model` exits 0 with a warning: "semantic layer unavailable … (install hint: pnpm add @huggingface/transformers)".
- **Impact:** the entire vector layer (embeddings, vec KNN in hybrid search, the markdown `doc` corpus) is unreachable for any pinned-npx consumer — which is the documented recommended install path. Hybrid `semantic_search` degrades to FTS5+file fusion (still functional, weaker).
- **Fix:** ship it in `dependencies` (or `optionalDependencies` with a clean install-time message). One-line package.json change; doubles the effective value of the npm distribution.
- **Status:** FIXED in 0.3.4-dev — ships in `optionalDependencies` pinned to `"3.8.1"` (exact): default installs get the vector layer, `--omit=optional` is the escape hatch, and the existing `SemanticUnavailableError` stays the fallback message. This reverses the recorded EMBD-07 decision; the embedder comment and USAGE document the new posture.

### DI-02 — Java records are not captured as symbols (MEDIUM)

- **Evidence:** live fixture indexed with the 0.3.2 dist: `public record Money(BigDecimal amount, String currency)` yields only its method `add` as a symbol; a sibling `public class PlainService` in the same file IS captured.
- **Impact:** name-seeded retrieval cannot find record types — increasingly common in modern Java (the test workspace's core domain type `Money` is a record and was invisible to `retrieve`). Consumers must grep-fallback for type names.
- **Fix:** add `record_declaration` (and its header) to the Java tree-sitter symbol query alongside `class_declaration`.
- **Status:** FIXED in 0.3.4-dev — `record_declaration` → `'class'` AND `enum_declaration` → `'enum'` added to the Java nodeMap (`src/parser/languages.ts`); the "header" needs no extra machinery — the whole record node is captured (startLine..endLine cover header + body). Parse-level and walker-level tests cover a `Money` record and a `Status` enum.
- **Measured (A/B, Java demo, 2026-09-12):** query "monetary amount integer minor units currency validation" surfaced `Money.java` **0%** (only `MoneyTest.java` returned) → grep fallback required.

### DI-03 — Embedding model fetch has no revision pin (MEDIUM, reproducibility)

- **Evidence:** `fetchModel()` runs `tf.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')` — transformers.js resolves the HuggingFace repo's **current default revision**. No revision/etag/sha is recorded or verified anywhere (still true on 0.3.4-dev). (The sha256 machinery in `embed.ts` hashes **document text** for incremental re-embedding — not the model.)
- **Impact:** two machines fetching at different times may get different weights → different embeddings → non-reproducible retrieval results for identical code. Contradicts the "deterministic for identical inputs" posture consumers embed DeepIndex into.
- **Fix:** pin a revision sha in `MODEL_CONFIGS`, pass it to the pipeline fetch, and verify/record it in the cache marker. Optionally warn when a cached model's revision differs from the pin.
- **Status:** FIXED in 0.3.4-dev — `MODEL_CONFIGS` pins revision shas for both models (minilm `751bff37…`, bge `ea104dac…`); `fetchModel` and `loadRealEmbedder` pass `{ revision }` to every pipeline call; the marker `<cache>/<model>/.deepindex-model.json` records the fetched revision and verified digests; loads warn on pin drift and stay local-only (no download on the load path).
- **Measured (A/B, Java demo, 2026-09-12):** `application.properties` (persistence config) surfaced **0%** lexically — properties/markdown content is unreachable without vector mode; only file paths are indexed. Combined with DI-01 this is the fix that makes the markdown/doc corpus retrievable.

### DI-04 — Model weights are invisible to dependency audits (LOW-MEDIUM, supply chain)

- **Evidence:** weights arrive via an out-of-band runtime download; no checksum verification; not part of any SBOM a consumer's audit tooling (CycloneDX, osv-scanner) can see. The explicit opt-in gate (`--fetch-model`) and local-only inference are good — keep them.
- **Impact:** governance/framework consumers that run dependency-audit gates cannot account for the fetched artifact; tampering would be undetectable.
- **Fix:** checksum-verify the download, document the model's license (Apache-2.0) and origin in USAGE, and keep the download opt-in.
- **Status:** FIXED in 0.3.4-dev — fetch-time sha256 verification of present LFS weights against the HuggingFace tree listing; digests recorded in the marker file. USAGE "Semantic mode" documents origin, license, cache location, and an explicit SBOM/audit note (the fetched artifact is out-of-band for CycloneDX/osv-scanner). The `--fetch-model` opt-in gate is unchanged.

### DI-05 — `deepindex install` writes bare `deepindex` (MEDIUM)

- **Evidence:** the installer writes `command: 'deepindex'` for every harness target (`src/mcp/install.ts:31` for Claude Code; same pattern for codex/opencode/deepseek-harness; still true on 0.3.4-dev).
- **Impact:** (a) assumes a global install — breaks the documented pinned-npx posture (bare npx cache paths rotate and silently break); (b) the Claude target uses `.claude/settings.json` while the project-shareable convention is root `.mcp.json`; (c) the opencode target writes a plugin instead of an `mcp.<name>` entry, inconsistent with how those harnesses commonly wire MCP servers.
- **Fix:** write `npx -y deepindex@<version>` (version read from package.json at install time), add a `.mcp.json` target for Claude Code, and align the opencode target to the mcp entry schema.
- **Status:** FIXED in 0.3.4-dev — all four targets generate `npx -y deepindex@<version>` (shared `src/version.ts`); Claude Code's MCP entry moved to root `.mcp.json` (hooks stay in `.claude/settings.json`, pre-existing entries never deleted); OpenCode gains an `mcp.deepindex` entry in root `opencode.json` (the event plugin is kept for hook events, now pinned).

### DI-06 — MCP tools do not auto-git-sync (LOW-MEDIUM)

- **Evidence:** CLI `retrieve`/`search` auto-run `git-sync` before querying (cli.ts); the MCP tool handlers (`src/mcp/tools.ts`) contain no git-sync call (still true on 0.3.4-dev).
- **Impact:** long-lived MCP sessions (agent harnesses keep the server running) serve a stale knowledge graph — decisions/bugfixes/patterns from recent commits are missing without a manual `index .` re-run.
- **Fix:** run the cheap git-sync at the start of MCP tool calls (same seam the CLI uses), or expose an explicit `refresh` MCP tool / TTL.
- **Status:** FIXED in 0.3.4-dev — `syncSafe` (the CLI's non-fatal git-sync seam, now shared out of `src/git/indexer.ts`) runs at the start of every MCP tool handler; a test proves an entity from a commit made AFTER the initial index is visible without any manual sync.

### DI-07 — Undocumented preconditions and exit-code semantics (LOW, docs)

- **Evidence:** `index` requires only `existsSync(repoPath)` — a path check, not a git check ("repository not found" exit 2) — but the git-dependent knowledge-graph layer then silently degrades in non-git directories. `health` exits 2 (no index) vs 1 (score below `repair_below`) vs 0 — the 1-vs-2 distinction is not obvious from docs.
- **Impact:** an integrator (this one included) can misread the path precondition as an npx failure; scripted consumers need the health semantics spelled out.
- **Fix:** document both in README/USAGE; consider warning loudly when `index` runs outside a git repo.
- **Status:** FIXED in 0.3.4-dev — `index` now warns loudly on stderr outside a git repo (still exit 0: degradation, not failure); USAGE "Exit codes & preconditions" spells out per-verb semantics, including `embed`'s deliberate exit 0 on semantic-unavailable.

### DI-08 — No stemming / query normalization in the lexical `retrieve` path (MEDIUM)

- **Evidence (A/B, 2026-09-12):** query "monetary amount integer minor units currency validation" does not surface `Money.java` — token "monetary" matches neither the record name ("Money", also not a symbol yet — DI-02) nor the path token "money". Near-synonym phrasing misses exact symbols/paths whenever vector mode is off (the npx default per DI-01/DI-03).
- **Impact:** same-vocabulary queries work (measured 3/5 precision on a 7-file Java demo); cross-vocabulary phrasing silently misses → consumers hit the grep fallback and lose the token win.
- **Fix (two complementary):** (a) cheap — light stemming/case/normalization + substring match on path tokens (the engine already LIKE-matches symbol names; extend to paths); (b) correct long-term — vector mode (DI-03), which is what actually bridges near-synonyms.
- **Status:** FIXED in 0.3.4-dev — (a) landed: light plural variants are probed additively (exact matches never narrowed) and file paths now LIKE-seed at depth 0, so symbol-free files are reachable; (b) reachable: with DI-01 the transformers stack installs by default and DI-03 makes fetches reproducible.

### DI-09 — Document path-aware retrieval & query phrasing (LOW, docs)

- **Evidence:** file PATHS are tokenized, so an identifier/path term in a query can recover a file with no matching symbols — `application.properties` is reachable via a query containing "application"/"properties" despite properties having no symbols (the datasource/jdbc A/B query missed it; a path-aware query would not).
- **Impact:** integrators may over-rely on concept-only phrasing; a two-word identifier/path hint raises recall at zero code cost.
- **Fix:** document in README/USAGE (and integrator skill guidance) that `retrieve` indexes file paths + symbol names; advise phrasing queries with both a concept and a likely identifier/path term.
- **Evidence correction (verified against the code):** the original claim — "a path term in a query can recover a file with no matching symbols" — was FALSE against the pre-fix engine: `retrieve()` seeds exclusively from symbol matches and early-returns `[]` otherwise, and FTS5 indexes git-derived entities only. `application.properties` was unreachable by ANY lexical phrasing before this pass. The DI-08(a) path-seeding fix makes the claim true; the docs were written only after the behavior existed.
- **Status:** FIXED in 0.3.4-dev — USAGE "Retrieval tips" + README document path+symbol matching and the concept-plus-identifier phrasing advice, with the measured A/B caveat noted for near-synonym phrasing (needs semantic mode).

## Fixed — for the record

- **Stale `0.1.0` version literal** in `--version`/`serverInfo` — fixed in 0.3.3 (version read from package.json). **Correction found during the 0.3.4-dev pass:** the 0.3.3 fix only covered `--version`; the MCP serverInfo still hardcoded `'0.1.0'` (`src/mcp/server.ts`) — an MCP client saw a stale version in the initialize handshake. Now fixed via the shared `src/version.ts` `readVersion()` with a handshake-level test.
- **npx one-shot appearing dead** during long parses — fixed in 0.3.3 (liveness signals on stdout before parse).
- **Bare invocation** printing help to stderr + exit 1 — fixed in 0.3.3 (help on stdout + exit 0).

## Verified working — no action needed

- Pinned `npx -y deepindex@<ver>` end-to-end: `index`, `retrieve`, `search`, `mcp serve` (initialize + tools/list handshake) all verified live on 0.3.2 and 0.3.3.
- Explicit opt-in model gate — no silent runtime download; `loadRealEmbedder` refuses on empty cache with the exact bootstrap command.
- Local-only inference — code snippets never leave the machine; only the one-time model fetch touches the network.
- Graceful degradation everywhere — every semantic/vector failure is a warning + lexical fallback, never a crash.
- User-level state (`~/.deepindex/projects.json`, `~/.deepindex/models`) shared across npx/global/local installs.
- Hybrid `semantic_search` design: RRF fusion of FTS entities + vec KNN + `retrieve` file hits; lexical mode always functional.
- WASM tree-sitter grammars bundled in the tarball (30 grammars incl. Java, markdown) — no checkout needed under npx.