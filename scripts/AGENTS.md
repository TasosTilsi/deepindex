<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# scripts

## Purpose
Standalone operational scripts — end-to-end smoke checks and self-checks that exercise the framework against the fixture repo without a test runner.

## Key Files
| File | Description |
|------|-------------|
| `selfcheck-phase2.mjs` | Phase-2 E2E: builds `fixtures/sample-repo`, prints getHealth/retrieve/repair output, records a vitest signal and re-prints health |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Scripts run with `pnpm smoke` (tsx) or plain `node`; they resolve the fixture relative to `process.cwd()` — run from repo root.
- Phase-2 self-check predates the phase-3 CLI; a new phase may supersede it — keep behavior aligned, don't duplicate.

### Testing Requirements
- `pnpm smoke` from repo root must complete with a `[selfcheck]` line per step and exit 0.

### Common Patterns
- mkdtemp in OS tmpdir for the scratch DB; cleanup via process exit.

## Dependencies

### Internal
- `../src/index.ts` — public API

### External
- Node stdlib (fs/os/path)

<!-- MANUAL: -->
