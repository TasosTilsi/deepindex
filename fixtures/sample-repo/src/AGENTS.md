<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-08-09 | Updated: 2026-08-09 -->

# src

## Purpose
Fixture source files. A short import chain that resolves end-to-end plus one dead-end file, exercising symbol extraction, import resolution, edge building, and retrieval ranking against known shapes.

## Key Files
| File | Description |
|------|-------------|
| `a.ts` | `foo()` imports `bar` from `./b` |
| `b.ts` | `bar()` imports `baz` from `./c` |
| `c.ts` | `baz()` imports `./missing` (broken import) + exports `ANSWER = 42` |
| `thread-counter.ts` | `countThreads()` — standalone exported function |
| `with-comments.ts` | `auth()` preceded by header comments — tests summary extraction skipping comment lines |

## Subdirectories
None.

## For AI Agents

### Working In This Directory
- Keep the chain shapes stable — tests assert on `foo`/`bar`/`baz` resolution depth, the broken `./missing` import, and comment handling.
- Files are fixture data, not production code; keep them minimal and intentionally patterned.

### Testing Requirements
- After edits, run `pnpm test` (graph/retrieve/repair suites) and `pnpm smoke`.

### Common Patterns
- One concern per file, clearly named (`thread-counter`, `with-comments`).

## Dependencies

### Internal
- `../` sample-repo fixture root

### External
- None

<!-- MANUAL: -->
