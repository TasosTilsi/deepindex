# ADR-004: TypeScript Stack

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

The reference implementations (cobi, Recall) are Python. The project needed a stack for a Node-based context engineering framework.

## Decision

Use **TypeScript** (ESM, NodeNext). Port ideas from the Python references, not code.

## Consequences

- **Positive:** Type safety, shares the Node ecosystem with AI harnesses, single language across CLI + dashboard.
- **Negative:** Some Python libraries (GitPython, FastMCP) have no direct TS equivalent — ported via `child_process` / official SDKs.
