# ADR-005: Eight Refined Entity Types

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

Recall used 8 entity types (`decision, bug_fix, pattern, file, concept, tech_debt, workflow, business_rule`). For a context-engineering framework, `file` is redundant (the symbol graph already indexes files) and `business_rule` overlaps `decision`/`concept`.

## Decision

Use **8 refined entity types**: `decision, bug_fix, pattern, tech_debt, concept, breaking_change, security_fix, workflow`. Dropped `file` and `business_rule`; added `breaking_change` and `security_fix`.

## Consequences

- **Positive:** Types map to what an agent needs to know (what changed, what's broken, what's a security risk).
- **Negative:** `breaking_change`/`security_fix` need heuristic detection (API signature change, CVE/security keywords).
