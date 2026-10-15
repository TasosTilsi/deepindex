# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries reference the issue that drove the change. Every measured number in this file comes
from a recorded run in the repository named in the entry; nothing is estimated.

## [Unreleased] — 0.3.5

Version bumped, not yet tagged or published. Closes the fifteen issues opened after the
0.3.4 integration (#3–#17), each with a failing test on record before the fix.

### Fixed

- **The import graph was wrong for most real repositories.** Two independent defects:
  - Every non-relative specifier — `node:` builtins, npm packages, workspace aliases — was
    stored as a broken import, because `resolveImport` returned null for anything not
    starting with `.`. On this repository that flagged **456 of 482 imports (94.6%)** and
    pinned `consistency` at 0.054. Externals are now an explicit, indexed classification
    (`imports.external`), and the consistency dimension is computed over in-repo imports
    only, so external mass can neither dilute the ratio nor hide a genuine break. (#8)
  - Relative imports written with the **emitted** extension never resolved:
    `import { db } from './db.js'` against a `db.ts` on disk, which is what TypeScript's
    NodeNext convention prescribes and what this repository itself uses. 213 of 239
    in-repo imports were false negatives. Together with the classification fix, the same
    repository went from **485 unresolved imports to 1** — the one remaining being the
    deliberate broken import in the test fixture — with `consistency` 0.0509 → **0.9959**
    and the health score 42 → **80**. (#16)
- **`consistency` and, with it, the graph were empty for Java.** Java contributed no import
  rows at all (the extractor matched only the JS/TS `import_statement` node), and no Java
  symbol was ever marked `exported`, so even a resolved import could not become an edge.
  Both landed together on purpose: extraction alone made Java scores *worse* (60 → 53),
  and resolution alone still produced zero edges. A Maven-layout fixture now reports
  `consistency` 1.0000 with real edges, and no `pom.xml` parsing was needed — a Java source
  names its own FQN. (#5, #13)
- **The health report looked complete when it was not.** The issue list was capped at 100
  with nothing in the payload to say so — on this repository that hid 356 of 456 rows — and
  the repair LLM prompt embedded the truncated list twice. `HealthReport` now carries
  `issuesTotal`, `issuesTruncated` and `issueSummary` (the ten most frequent groups over the
  full set), and `deepindex health --issues-limit/--issues-offset` pages the list. (#9)
- **The signal contract could not be used as documented.** `recordSignal` enforces values
  in `[0,1]`, so the `_total` keys were presence flags whose values were ignored; requiring
  them made a lone `tests_pass` raise `confidence` while leaving `coverage` at its neutral.
  The reader now consumes the value directly, `_total` stays accepted and ignored, and
  `coverage_lines` — written by tests, read by nothing — is documented as outside the score
  rather than silently inert. (#12)
- **The checksum verification added in 0.3.4 never verified anything.** It hashed
  `<cacheDir>/<model>/<path>` while a revision-pinned fetch stores files under
  `<cacheDir>/<model>/<revision>/<path>`, so every candidate was skipped and the marker
  recorded `verified: []`. Fixed, and a mismatch between the tree listing and what is on
  disk is now reported instead of passing quietly. (#14)
- **A merge commit with a lowercase subject lost its data.** The walker skipped merges by
  matching the subject against `Merge `; `git merge -m "..."` does not produce that, so the
  commit's two parents were handed to `git diff` as a single argument and the run failed with
  `fatal: ambiguous argument '<p1> <p2>'` — on stderr, exit code 0, with the commit's files,
  entities and backlinks silently dropped. The diff is now taken against the first parent,
  which is what the code always claimed to do. (#3)
- **`check-req-coverage` printed a literal `\n`**, `docs/DESIGN.md` listed a verb group that
  does not exist and the wrong MCP tool count, and `docs/adr/README.md` was missing its
  ADR-0010 row. (#15)

### Added

- **`deepindex signal`** — the CLI surface the health score was missing. `recordSignal` had
  no caller outside tests, so `coverage` and `confidence` sat on their neutral fallbacks and
  the score was capped at exactly 80, the default `repair_below`, which in turn made
  `sessionStart` run the repair pipeline on repositories that were fine. Accepts
  `key=value` pairs (counts or ratios), `--reset`, and `--from-vitest`, `--from-eslint`,
  `--from-junit` (a file or a directory — one parser covers surefire, pytest, Gradle,
  dotnet and cargo-nextest). A numerator is divided by its denominator and the partner key
  is written as the sentinel `1.0`, so an older reader gets the same answer. (#4)
- **Offline / air-gapped semantic search.** `[semantic] model_path` (and
  `DEEPINDEX_MODEL_PATH`, which wins) points the embedder at a local HuggingFace /
  `optimum-cli export onnx` directory; `--fetch-model` then skips the download entirely.
  Every load path now forbids remote fetches, so a partially populated cache can no longer
  fall through to a silent download — which the code had always claimed it never did. (#6)
- **`deepindex requirements import <file> --format jira|github|deepindex`** with
  `--dry-run` and `--json`. Adapts a tracker export offline, and `get_entity("PROJ-123")`
  now answers with the requirement, its atomic statements, the symbols linked through `@req`
  annotations and the commits that cite it — derived as a query rather than stored, so it
  cannot go stale. (#7)
- **Configurable index ignores.** One shared ignore set for the symbol graph and the markdown
  corpus, with the regenerable toolchain caches (`.nx`, `.turbo`, `.output`, `.gradle`,
  `.idea`, `tmp`) covered by default and `[index] ignore = [...]` per repository. On the
  ai-ready-nx-workspace integration this dropped 24 files of cache and scratch noise from the
  index. (#10)
- **`SCHEMA_V7`** moves the requirements tables into the shared schema. They were created only
  by the requirements verbs, so a database that never ran one had no such table and any other
  surface touching requirements would have failed with "no such table". (#15)
- A test suite for the release workflow, which had none — see below. (#11)

### Added

- **`deepindex install` now onboards the repository**, not just the harness: it creates
  `.deepindex.toml`, adds the index artifact to `.gitignore`, adds the `di:*` npm scripts
  pinned to the same `npx -y deepindex@<version>` the wiring uses, backs up every file it may
  rewrite into `.deepindex-backup/<timestamp>/`, and indexes the repository with a health
  reading before returning. `--dry-run` reports all of it and writes nothing; `--no-index` and
  `--no-scripts` opt out of parts; `--guidance` appends a retrieval nudge once, off by
  default. This replaces the separate bootstrap shell script, whose pnpm allowlist had
  silently stopped working because it wrote to `package.json#pnpm`, a location pnpm 10 and
  later no longer read. (#19)
- **A refusal you can rely on:** an unparseable `.claude/settings.json` stops install with
  exit 1 and writes nothing at all, instead of replacing the file with one holding only
  deepindex's hooks. When the four hook events already exist they are named on stderr before
  being replaced. (#19)

### Added

- **C# is extracted and resolved**, through the same in-tree map as Java, Kotlin and Scala, since a
  `using` names a namespace. The map reads `namespace` where the others read `package`, and it now
  records every namespace *prefix* it knows, because a project need not declare its parent namespaces
  in files of their own — `using App.Gone;` is inside the project when `App` is a prefix of something
  here, and calling it external hid a dangling reference. (#20)
- **Swift, PHP and Elixir are extracted and resolved** — the last languages whose imports can name a
  file here. A Swift import names a module, linked to the first file of its `Sources/<Module>/`
  target directory; a PHP `require`/`include` resolves relative to the working directory then the
  file and stays external when unresolvable (`include_path` may hold it), while the
  `__DIR__ . '/x.php'` concatenation form produces no row; an Elixir `alias`/`import` is mapped by
  convention to `lib/my_app/accounts/user.ex`. (#20)
- **Kotlin and Scala are extracted and resolved** through the same in-tree map Java uses — they
  spell imports the same way (a package declaration plus a dotted path), so the map is now shared
  rather than copied, and named for what it does (`package-resolve.ts`). The differences the map had
  to learn: their `package` lines carry no semicolon, their file stems are not `.java`, and Scala
  writes `_` where Java writes `*` while `import a.b.{C, D}` reads down to the package `a.b` — a bare
  path that names a package now resolves to that package. (#20)
- **Go, Lua, Bash and Dart are extracted and resolved.** A Go import names a *package directory*, so
  the module path is read from `go.mod` and the package links to its first file in path order — a
  deliberate directory-level approximation, since the graph is file-to-file and a package is several
  files. A miss inside the module is broken; the standard library and other modules stay external.
  Lua's `require('mod.sub')` maps onto `mod/sub.lua`, Bash's `source ./x.sh` resolves relative to the
  working directory then to the script (a miss is broken — the path is explicit), and Dart's
  `import 'src/x.dart'` resolves relative to the file while `package:` URIs are not extracted. Go
  exports what it capitalises and Dart hides what it prefixes with `_`, so visibility is now read
  from the name where the language says so. (#20)
- **Ruby and the C family are extracted and resolved.** `require_relative 'helper'` is relative to
  the file, so it resolves (normalised to `./helper`) and a miss is broken; a bare `require 'json'`
  stays an external row, like `import express` does. A quoted `#include "local.h"` is looked for
  next to the file, at the repository root, then under `include/`, and an unresolved one stays
  **external rather than broken** — reporting it broken would fill the health report with false
  positives for every header that lives behind a `-I` directory. Angle-bracket includes are system
  headers and produce no row. Ruby symbols report `exported` (no visibility keyword), and C symbols
  report it unless `static` makes them file-local. (#20)
- **Rust imports are extracted and resolved.** `use` and `mod` declarations produced no rows, so
  no edge could exist whatever the export flag said. A path is resolved the Rust way: `crate::` is
  the crate root (`src/`), `self::` the current module's directory, `super::` its parent, and the
  file to link is the **longest module prefix** of the path — `use self::local::Thing;` links
  `local.rs`, because the last segment names an item inside the module. `mod helpers;` is itself a
  file reference. A path that fails from an in-crate root is broken; `::serde::Serialize` and a bare
  external crate stay external. Rust also needs the **inverse** visibility rule — `pub` marks what
  is importable, so the absence of a modifier means private, where Java's `private` marks the
  opposite side. (#20)
- **Python imports are extracted and resolved.** Python produced no import rows at all: the
  extractor read the JS/TS `import_statement` `source` field and Java's `import_declaration`, and
  Python's imports are neither — `import a.b, c.d` carries one `dotted_name` per module, and
  `from .mod import x` is an `import_from_statement` whose `module_name` field is a
  `relative_import`. A specifier is now resolved as a package path: `import pkg.mod` against the
  repository root and a `src/` layout, `from ..pkg import x` by climbing one package per leading dot
  from the module's own package. A relative miss is broken; `import os` stays external. Python
  symbols also report `exported`, since the language has no visibility keyword. (#20)


- **A warning count can no longer change the lint signal.** `signal --from-eslint` mapped ESLint
  to `errors / (errors + warnings)`, which the reader turns into `lint_factor = 1 - value`. One
  error with no warnings therefore stored 1.0 and drove `coverage` to zero, while the *same* error
  beside ninety-nine warnings stored 0.01 — a dirtier report scoring better, saturating for any
  error-only run, and firing auto-repair on repositories that were fine. It now stores the share
  of linted files that reported at least one error: bounded, proportional, and independent of how
  many warnings surround the failure. `parseEslintJson` exposes that count as `filesWithErrors`.
  Found by the pre-release review, not by the suite — which had pinned the wrong value. (#4)

- `deepindex install` and the harness wiring are unchanged; the release workflow is not.
  The tag-triggered workflow could not fail: it published twice and ended in `true`, and its
  registry gate grepped for the literal `"0.3.4"`, which is true forever once shipped. It also
  requested `contents: read`, so `gh release create` would have been refused with a 403 even
  after a good publish. There is now one real publish that is allowed to fail the job, the
  OIDC diagnostics run only on failure, and the gate names the version being released. (#11)
- **Upgrade note: run `deepindex index . --rebuild` once.** The classification is written when
  a file is parsed and the incremental indexer skips unchanged files, so an existing index
  keeps its old readings — an incremental re-index left 310 imports unresolved where a full
  rebuild left 1.
- `consistency` reads 0.5 (neutral) for a repository whose only imports are external, since
  there is nothing internal to resolve. That is a deliberate reading, not a defect: the
  previous behaviour was 0.0 for such a repository, and 0.99 in the presence of a hundred
  external imports and one genuine break.

### Deferred

Recorded in the issues rather than half-shipped: the live Jira/GitHub pull and its credential
model (#7), a `--from-playwright` parser (#4), full `.gitignore` semantics for the index walk
(#10), Kotlin/Scala import resolution and workspace path aliases (#5, #16), a manual publish
fallback if trusted publishing fails again (#11), Linear/Azure DevOps adapters (#7), and the
intermittent `repair.test.ts` rebuild flake (#18).

## [0.3.4] — 2026-09-12

The integration release: everything found while wiring deepindex into
[ai-ready-nx-workspace](https://github.com/codeaiforge/ai-ready-nx-workspace), closed
test-first (`docs/ISSUES.md`, DI-01…DI-09 and N-01).

### Fixed

- DI-01 — `@huggingface/transformers` ships as an `optionalDependency`, so pinned-`npx`
  consumers get the vector layer by default.
- DI-02 — Java `record` and `enum` declarations are captured as symbols.
- DI-04 — sha256 verification of fetched LFS weights against the HuggingFace tree listing.
  *(Later found not to be in force: the verification hashed the wrong cache level. Fixed in
  0.3.5 — see #14.)*
- DI-05 — the installer pins `npx -y deepindex@<version>` across all four harness targets
  instead of writing a bare `deepindex`.
- DI-06 — MCP tool handlers run an incremental git-sync before answering, so a long-lived
  server does not serve a stale knowledge graph.
- DI-08 — retrieval seeds from file paths as well as symbols, and probes light plural
  variants, so symbol-free files and near-miss terms are reachable.

### Added

- DI-03 — the embedding model revision is pinned per release and recorded in the cache
  marker; a drift is reported on load rather than silently differing between machines.
- DI-07 — documented exit codes and preconditions, and a loud warning when `index` runs
  outside a git repository.

### Documentation

- DI-09 — USAGE and README explain that `retrieve` matches file paths *and* symbol names,
  and advise phrasing a query as a concept plus a likely identifier.

## [0.3.3] — 2026-09-10

### Fixed

- The `npx` one-shot entry point read as "did nothing": a bare invocation printed help to
  stderr and exited 1, `--version` reported a stale literal, and a long first parse looked
  like a hang. Help now goes to stdout with exit 0, the version is read from `package.json`,
  and long-running verbs emit liveness on stdout. (#2)

## [0.3.2] — 2026-09-10

### Added

- `sessionStart` runs a deterministic auto-repair (rebuild, cache invalidation, git-history
  probe) when the stored health score is below `repair_below`; the LLM stage stays manual.

## [0.3.1] — 2026-09-10

### Added

- An npm-publishable package layout, with the dashboard bundled so a global or `npx`
  install serves the UI without a checkout.

## [0.3.0] — 2026-09-09

### Added

- Semantic retrieval: local embeddings, a `sqlite-vec` KNN store, and hybrid search that
  fuses FTS5 entities, vector neighbours and file hits with reciprocal rank fusion.
- Local-only inference with an explicit `--fetch-model` opt-in as the single network path,
  and a lexical fallback whenever the vector layer is unavailable.

[Unreleased]: https://github.com/TasosTilsi/deepindex/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/TasosTilsi/deepindex/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/TasosTilsi/deepindex/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/TasosTilsi/deepindex/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/TasosTilsi/deepindex/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/TasosTilsi/deepindex/releases/tag/v0.3.0
