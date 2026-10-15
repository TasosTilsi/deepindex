/**
 * Directory reading that does not follow symlinks.
 *
 * A repository is untrusted input, and `readdirSync(dir)` + `statSync(full)` follows a symlink: a
 * repository that commits `ln -s "$HOME/.aws/credentials" src/config.ts` had that file indexed (its
 * bytes read, hashed, parsed) and `retrieve` read it back into the model's context. The same missing
 * check let `ln -s .. up` recurse — a two-file repository indexed 81 entries, forty levels deep.
 *
 * Every walk in this codebase goes through this reader, so the rule lives in one place: report the
 * entries that really are inside the directory, and omit symbolic links entirely. Skipping them also
 * removes the only way a directory graph can contain a cycle, which is why no visited-set is needed.
 *
 * The cost is deliberate and documented: a symlinked vendored directory is not indexed. That is the
 * same default `ripgrep` takes, and the alternative — resolving each link and checking containment —
 * buys nothing a hostile repository cannot make irrelevant by linking to a path inside the repo it
 * also controls.
 */
import { readdirSync } from 'node:fs';

export interface SafeDirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
}

/** Entries of `dir` with symbolic links removed. An unreadable directory yields none. */
export function readDirSafe(dir: string): SafeDirEntry[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
}
