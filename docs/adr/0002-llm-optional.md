# ADR-002: LLM Optional (Deterministic-First)

- **Status:** Accepted
- **Date:** 2026-08-09

## Context

The reference implementations (Recall) made LLM extraction the only path. The user required: "context can be retrieved without llms."

## Decision

All indexing and retrieval is **deterministic and LLM-free by default**. LLM summarization/extraction is caller-supplied enrichment (`repair({ llm })`) — never required, and not reachable through configuration. An earlier revision of this ADR promised an `llm.enabled` flag; no such key exists in the code.

## Consequences

- **Positive:** Works offline, no API key, deterministic, token-efficient.
- **Negative:** LLM-based extraction (e.g. richer entity content) is a configurable upgrade, not the default.
