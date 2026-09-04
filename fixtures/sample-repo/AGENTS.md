<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# sample-repo

## Purpose
Canonical fixture repository. A deliberately small TS project whose shape exercises the framework: a resolved import chain (`a.ts → b.ts → c.ts`), one broken import (into `./missing`), a root-level doc file with a `// CLAIM:` that the git-history repair stage can contradict, and its own git history.

## Key Files
| File | Description |
|------|-------------|
| `.ctx.toml` | Health config: `repair_below = 80` |
| `outdated-doc.ts` | Root-level doc file; `// CLAIM: there are 4 worker threads` against `WORKER_THREADS = 4` |
| `.git/` | Embedded git repo (fixture has commits so `stage3GitHistory` runs) |

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `src/` | Fixture source files (see `src/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- The embedded `.git` dir is part of the fixture — do not delete or `git init` over it; stage 3 needs it.
- Do not "fix" the broken import or the CLAIM contradiction — they are intentional test inputs.

### Testing Requirements
- Fixture changes ripple into `tests/graph|retrieve|repair|health` and `scripts/selfcheck-phase2.mjs`; verify after editing.

### Common Patterns
- Root-level `.ts` docs sit outside `src/` on purpose (repair stage 3 scans both repo root and `src/`).

## Dependencies

### Internal
- Referenced from `../` fixtures doc; consumed by `tests/` and `scripts/`

### External
- None (git executable required at repair-test runtime for `git log`)

<!-- MANUAL: -->
