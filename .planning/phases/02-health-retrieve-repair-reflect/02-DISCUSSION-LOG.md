# Phase 2 Discussion Log

**Date:** 2026-07-25
**Phase:** 02 — Health + Retrieve + Repair + Reflect
**Mode:** interactive, default

## Areas Discussed

### 1. Health scoring shape (4 questions)

**Q1.1 — How dimensions combine into 0-100 score**
- Option: Weighted average (selected, recommended)
- Option: Min-of-dimensions (gating)
- Option: Geometric mean
- **Decision:** Weighted average, weights 0.30/0.30/0.20/0.20 for
  freshness/consistency/coverage/confidence.

**Q1.2 — How each dim is computed**
- Option: Per-dim explicit formula (selected, recommended)
- Option: Pluggable scorer per dim
- Option: Single function, fixed shape
- **Decision:** Explicit formula in health module. No plugin system in v1.

**Q1.3 — Missing source data**
- Option: Default to 1.0 (no penalty)
- Option: Default to 0.5 (neutral) (selected)
- Option: Omit dim, renormalize weights
- **Decision:** Default 0.5. Triggers early repair to gather evidence.

### 2. Repair policy + LLM gate (3 questions)

**Q2.1 — Deterministic scope**
- Option: Re-build + cache invalidate + git history + LLM (selected, recommended)
- Option: Re-resolve imports + LLM only
- Option: LLM-only repair
- **Decision:** 4-stage pipeline, LLM last. Covers most issues with
  re-parse + cache management; LLM is the rarest path.

**Q2.2 — LLM gate threshold**
- Option: Composite < 80, configurable (selected, recommended)
- Option: Per-dim min < 0.7
- Option: Two-tier (warn 80 / repair 60)
- **Decision:** Composite 80 default, `.ctx.toml [health] repair_below`.

**Q2.3 — LLM client shape**
- Option: OpenAI-compatible POST, generic (selected, recommended)
- Option: OpenAI SDK only
- Option: Provider abstraction (config-driven)
- **Decision:** `OpenAICompatibleClient({baseUrl, apiKey, model})` POSTs
  to `{baseUrl}/chat/completions`. Works for OpenAI, Ollama, LM Studio,
  llama.cpp.

### 3. Retrieval ranking (2 questions)

**Q3.1 — Combine rule**
- Option: Weighted linear combo, α=0.6 (selected, recommended)
- Option: Reciprocal Rank Fusion (RRF)
- Option: Two separate ranked lists
- **Decision:** `score = 0.6·tfidf + 0.4·graph_proximity`. Simple, tunable.

**Q3.2 — Seeds + K**
- Option: Symbol-name match → BFS, K=10 (selected, recommended)
- Option: File-level seeds only
- Option: Skip graph BFS, TF-IDF only
- **Decision:** Seeds from symbol-name regex match, BFS dependents to
  depth 2, default K=10.

### 4. Reflect input formats (2 questions)

**Q4.1 — Input shape**
- Option: Parsers only, strict JSON formats (selected, recommended)
- Option: Reflect invokes tools itself
- Option: Loose-text regex parsers
- **Decision:** Three pure parsers (`parseVitestJson`, `parseEslintJson`,
  `parseCoverageJson`). Caller runs tool, pipes JSON in. Phase 2 ships
  parsers; phase 3 wires CLI.

**Q4.2 — Where parsed signals live**
- Option: SQLite signals table, same DB (selected, recommended)
- Option: In-memory, caller threads in
- Option: JSON file on disk
- **Decision:** New `health_signals(key, value, source, updated_at)`
  table. Bumps `SCHEMA_VERSION` 1 → 2.

## Deferred (during discussion)

- Neo4j / Memgraph — revisit at scale.
- Vector embeddings — only if TF-IDF recall proves insufficient.
- Prompt-injection scanner on retrieved content.
- Per-dim thresholds (instead of one composite).
- Long-term session memory (external concern).
- Auto-watch tool output.
- Per-folder health drill-down.
- Coverage-over-time trend.

## Outside-of-phase captures

- `context-engineering-article.txt` provided as project framing doc.
  Mapped to phase 2 modules: principles 1/4/5/6/7 → RTRV, principles 6/7
  → REPR. Cited in CONTEXT.md canonical_refs.

## Claude's discretion items

None — every area resolved by user selection.
