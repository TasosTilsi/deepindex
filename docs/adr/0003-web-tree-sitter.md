# ADR-003: web-tree-sitter (WASM) over Native tree-sitter

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

Native `tree-sitter` 0.25 doesn't compile on Node 24 (V8 API drift) and has no prebuilt for ABI 137.

## Decision

Use **`web-tree-sitter`** (WASM) for parsing. It is lazy-correct and works across Node versions without native compilation.

## Consequences

- **Positive:** No native build; works on Node 24; multi-language grammars load from `.tree-sitter/`.
- **Negative:** WASM loading adds a small startup cost; grammars must be vendored.
