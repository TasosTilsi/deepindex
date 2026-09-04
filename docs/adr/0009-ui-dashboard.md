# ADR-009: UI Dashboard (React + Vite, taste-skill)

- **Status:** Accepted
- **Date:** 2026-08-11

## Context

The user wanted a dashboard to visualize the whole index + knowledge graphs so "anyone can understand much easier and better what is the information holding."

## Decision

Build a **React + Vite** read-only dashboard (5 views: Overview, Knowledge Graph, Data Flow, Search, Symbols), using **vis-network** for graph visualization, served by extending `serve.ts`. Design follows the **taste-skill minimalist** language (warm monochrome, editorial typography, flat bento grids, subtle motion).

## Consequences

- **Positive:** Rich charts + visualizations; first frontend build in the project; read-only, no LLM, one `.db`.
- **Negative:** Adds a frontend build pipeline (Vite) + frontend deps to a TS/Node project.
