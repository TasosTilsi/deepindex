/**
 * File-relative path resolvers for the languages whose imports are plain paths (issue #20).
 *
 * Each is a few candidates and a stat — no shared abstraction, because their semantics differ in the
 * one place that matters: what a miss means. A `source ./x.sh` that has no file is broken (the path
 * is explicit); a Lua `require 'mod.sub'` that has no file is a C module or a system module and stays
 * external; a Dart `import 'src/x.dart'` that has no file is broken, while `package:foo/x.dart`
 * belongs to a dependency and never gets here.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The candidate is returned **as the files table stores it** — normalised, so `./lib/helper.sh`
 * becomes `lib/helper.sh`. Returning the raw specifier would resolve to a path the table has never
 * heard of, and the caller would count a perfectly good import as broken.
 */
function firstFile(repoRoot: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    const absolute = resolve(repoRoot, candidate);
    if (isFile(absolute)) return relative(repoRoot, absolute);
  }
  return null;
}

/**
 * Lua's `require('mod.sub')` maps a dotted module name onto a path with the separator and the `.lua`
 * extension of the runtime's `package.path`, which conventionally starts at the working directory.
 */
export function luaResolve(repoRoot: string, fromFile: string, source: string): string | null {
  const stem = source.split('.').join('/');
  return firstFile(repoRoot, [
    `${stem}.lua`,
    join(dirname(fromFile), `${stem}.lua`),
    join(stem, 'init.lua'),
  ]);
}

/**
 * A plain path, looked up relative to the working directory first and then to the importing file.
 * Bash's `source ./x.sh` and PHP's `require 'lib/helper.php'` both mean this, and neither says so
 * unambiguously — which is why a miss stays external in their callers' hands.
 */
export function pathResolve(repoRoot: string, fromFile: string, source: string): string | null {
  return firstFile(repoRoot, [source, join(dirname(fromFile), source)]);
}

/**
 * Elixir's module-to-file convention: `MyApp.Accounts.User` lives in `lib/my_app/accounts/user.ex`.
 * A module that is not there is a dependency (or `Logger`), and the caller calls it external.
 */
export function elixirResolve(repoRoot: string, source: string): string | null {
  const snake = source
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
    .join('/');
  if (!snake) return null;
  return firstFile(repoRoot, [`lib/${snake}.ex`, `test/${snake}.exs`, `${snake}.ex`]);
}

/** A Dart `import 'src/x.dart'` is relative to the importing file. `package:` never reaches here. */
export function dartResolve(repoRoot: string, fromFile: string, source: string): string | null {
  return firstFile(repoRoot, [join(dirname(fromFile), source)]);
}
