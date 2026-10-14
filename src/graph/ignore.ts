import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories the walks never descend into (issue #10): version control, dependency
 * trees, build output, coverage, virtualenvs, and the regenerable caches and scratch
 * space of common toolchains. Repos extend this per project with
 * `[index] ignore = [...]` in .deepindex.toml.
 *
 * One set, imported by both the index walk and the markdown corpus walk, so the
 * symbol graph and the doc corpus can never disagree about what is source.
 */
export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.omc',
  '.planning',
  '.claude',
  '.next',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  // Regenerable toolchain caches and scratch dirs (issue #10). An Nx workspace
  // keeps project-graph.json and source maps under .nx, which are large and are
  // not source; a scratch tmp/ can hold copies of entire projects.
  '.nx',
  '.turbo',
  '.output',
  '.gradle',
  '.idea',
  'tmp',
]);

export interface IndexConfig {
  /** Extra directory names to skip, from `[index] ignore`. */
  ignore: string[];
}

export const DEFAULT_INDEX_CONFIG: IndexConfig = { ignore: [] };

/**
 * Reads `[index] ignore = ["a", "b"]` from .deepindex.toml. Hand-rolled like the
 * other section loaders in this codebase (no TOML dependency). A malformed value is
 * ignored rather than fatal: a bad ignore list must never stop an index run.
 */
export function loadIndexConfig(repoPath: string): IndexConfig {
  const tomlPath = join(repoPath, '.deepindex.toml');
  if (!existsSync(tomlPath)) return { ...DEFAULT_INDEX_CONFIG };
  let text: string;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch {
    return { ...DEFAULT_INDEX_CONFIG };
  }
  const section = text.match(/\[index\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return { ...DEFAULT_INDEX_CONFIG };
  const list = (section[1] ?? '').match(/ignore\s*=\s*\[([^\]]*)\]/);
  if (!list) return { ...DEFAULT_INDEX_CONFIG };
  const ignore = (list[1] ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
  return { ignore };
}

/** The defaults plus whatever this repository configures. */
export function ignoredDirs(repoPath: string): Set<string> {
  return new Set([...DEFAULT_IGNORED_DIRS, ...loadIndexConfig(repoPath).ignore]);
}
