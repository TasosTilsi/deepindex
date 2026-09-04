<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# fixtures

## Purpose
Sample repositories used by tests, the self-check script, and CLI exercises. The fixture tree is treated as indexed input — its intentional flaws (broken imports, doc/claim contradictions) are what the health and repair stages are designed to detect.

## Key Files
None at this level.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `sample-repo/` | Canonical test repo — import chain, broken import, `// CLAIM:` docs, config (see `sample-repo/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- Files under fixtures are parsed by `buildGraph` and must remain valid TS (they are not part of the package build — tsconfig excludes `fixtures`).
- Changing fixture content changes graph/retrieve/repair test expectations; update tests together.
- Keep the fixture minimal — it exists to exercise specific failure modes, not to be a real codebase.

### Testing Requirements
- After fixture edits, run `pnpm test` and `pnpm smoke` to confirm expectations still hold.

### Common Patterns
- `.ctx.toml` per repo supplies health config (e.g. `[health] repair_below = 80`).
- `// CLAIM:` comment lines model out-of-band doc assertions checked by repair stage 3.

## Dependencies

### Internal
- Consumed by `tests/` and `scripts/selfcheck-phase2.mjs`

### External
- None

<!-- MANUAL: -->
