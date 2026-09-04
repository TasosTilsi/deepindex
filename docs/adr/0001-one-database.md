# ADR-001: One Database

- **Status:** Accepted
- **Date:** 2026-08-09

## Context

The framework indexes three knowledge layers: a symbol/import graph, a data-flow graph, and a temporal (git-history) knowledge graph. The reference implementations (cobi, Recall) used separate stores (e.g. `index.db` + `cobi_graph.db`).

## Decision

Use a **single SQLite database** (schema v5) for all three layers. The symbol graph, data-flow graph, and temporal knowledge graph live in one `.db` file, linked via foreign keys (`commit_files` → `files`, `entity_symbols` → `symbols`).

## Consequences

- **Positive:** One store to query; entity↔code linkage is a live graph edge; simpler backup/migration.
- **Negative:** Schema is larger; a migration ladder is needed as the schema grows.
