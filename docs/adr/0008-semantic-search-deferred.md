# ADR-008: Semantic Search Deferred (Optional Enhancement)

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

Recall had optional embeddings. The user asked whether to add semantic search with automatic model download + a reranker.

## Decision

**Defer semantic search to the end, as an optional enhancement** — not part of any phase. If added: embeddings + cross-encoder reranker (transformers.js, pure TS/WASM) gated behind `semantic.enabled`, explicit model fetch (no auto-download default), offline fallback to FTS5/TF-IDF.

## Rationale

Quality gain is query-dependent (prose/paraphrase yes, exact-symbol neutral); cost is unconditional (model download + compute + offline risk).

## Consequences

- **Positive:** Keeps the deterministic, offline, no-download default.
- **Negative:** Paraphrase/synonym recall is weaker than a semantic index would provide.
