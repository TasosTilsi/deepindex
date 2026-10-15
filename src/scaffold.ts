/**
 * Repo onboarding for `deepindex install`.
 *
 * Install used to write harness wiring and nothing else. Everything around the wiring — the
 * config, the gitignore entry for the index artifact, the npm scripts, the backup, the guard
 * before replacing someone's Claude hooks, the first index run — lived in a 500-line shell
 * script that called this CLI. That arrangement could only drift: the script's pnpm allowlist
 * wrote to `package.json#pnpm`, which pnpm 10+ no longer reads, so the step had silently
 * stopped working.
 *
 * Keeping the envelope here means it ships with the flags and config keys it depends on, it
 * is exercised by the suite, and it works the same on any machine with Node.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { npxCommand } from './version.js';

/** Where pre-existing files are copied before install may rewrite them. */
export const BACKUP_ROOT = '.deepindex-backup';

/** Files install may write in a project root. */
const SCAFFOLD_TARGETS = [
  'package.json',
  '.gitignore',
  '.deepindex.toml',
  '.mcp.json',
  'opencode.json',
  '.claude/settings.json',
  '.codex/config.toml',
  '.codex/hooks.json',
];

/** The four hook events install owns and therefore replaces. */
export const OWNED_HOOKS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'];

const DEFAULT_REPO_CONFIG = `# deepindex configuration — see docs/USAGE.md
[health]
repair_below = 80        # score below this -> \`deepindex repair\`

[hooks]
session_budget_ms = 10000  # per-session time budget for harness hooks

[semantic]
enabled = false          # local embeddings (opt-in; \`deepindex embed --fetch-model\`)

[index]
# ignore = ["vendor", "generated"]   # extra directories the index walk must skip
`;

const GUIDANCE_MARKER = '<!-- deepindex:retrieval-nudge -->';
const GUIDANCE = `${GUIDANCE_MARKER}
## Codebase knowledge (deepindex)

This repository is indexed by deepindex. For questions about existing code, prefer the
injected context and the deepindex MCP tools over \`grep\` or dumping whole files:

- \`search_knowledge\`, \`get_entity\`, \`get_backlinks\` — structure, decisions, history
- \`get_decisions\`, \`get_bugs\`, \`get_patterns\` — typed knowledge-graph entities

When using \`retrieve\`, phrase a query as a concept **plus** a likely identifier or path term
(for example "payment reconciliation Reconciler", not "money-matching logic").
<!-- /deepindex:retrieval-nudge -->
`;

export interface ScaffoldOptions {
  /** Report what would change and write nothing. */
  dryRun?: boolean;
  /** Append the usage guidance to the repository's instructions file (never duplicated). */
  guidance?: string | null;
  /** Add the di:* npm scripts when a package.json exists. */
  scripts?: boolean;
}

/**
 * Stops install when it would destroy something it cannot read.
 *
 * `installClaudeSettings` swallows a JSON.parse failure and writes its hooks anyway, which
 * replaces the whole file with one that has lost everything the user had in it. Refusing is
 * the safe behaviour, and it is what the shell script this replaces did.
 */
export function guardClaudeSettings(repoRoot: string): {
  blocked: boolean;
  warnings: string[];
  message?: string;
} {
  const path = join(repoRoot, '.claude', 'settings.json');
  if (!existsSync(path)) return { blocked: false, warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      blocked: true,
      warnings: [],
      message:
        '.claude/settings.json is not valid JSON (JSONC or comments?). deepindex would drop ' +
        'everything in it except its own hooks. Fix or remove the file, then re-run.',
    };
  }

  const hooks = (parsed as { hooks?: Record<string, unknown> }).hooks ?? {};
  const replaced = OWNED_HOOKS.filter((name) => hooks[name] !== undefined);
  return {
    blocked: false,
    warnings: replaced.length
      ? [`these hooks already exist and will be replaced: ${replaced.join(', ')}`]
      : [],
  };
}

/** Every scaffold target that exists, so the backup covers whatever install might touch. */
export function existingTargets(repoRoot: string): string[] {
  return SCAFFOLD_TARGETS.filter((rel) => existsSync(join(repoRoot, rel)));
}

/** Copies the targets into a timestamped directory. Returns the directory, or null if none. */
export function backupFiles(
  repoRoot: string,
  targets: string[],
  dryRun: boolean
): string | null {
  if (targets.length === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(repoRoot, BACKUP_ROOT, stamp);
  if (dryRun) return dir;
  for (const rel of targets) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(repoRoot, rel), dest);
  }
  return dir;
}

/** Adds the index artifact and the backup directory to .gitignore. Idempotent. */
export function ensureGitignore(repoRoot: string, dryRun: boolean): string[] {
  const wanted = ['.deepindex.db', '.deepindex.db-*', `${BACKUP_ROOT}/`];
  const path = join(repoRoot, '.gitignore');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const present = new Set(text.split('\n').map((line) => line.trim()));
  const missing = wanted.filter((line) => !present.has(line));
  if (missing.length === 0) return [];
  if (dryRun) return missing;

  const header = present.has('# deepindex')
    ? ''
    : '\n# deepindex — local index store (regenerable)\n';
  const body = text === '' ? '' : text.replace(/\n*$/, '\n');
  writeFileSync(path, `${body}${header}${missing.join('\n')}\n`);
  return missing;
}

/** Writes .deepindex.toml when absent. Returns true when it created the file. */
export function ensureRepoConfig(repoRoot: string, dryRun: boolean): boolean {
  const path = join(repoRoot, '.deepindex.toml');
  if (existsSync(path)) return false;
  if (!dryRun) writeFileSync(path, DEFAULT_REPO_CONFIG);
  return true;
}

/** Adds the di:* scripts, pinned the same way the harness wiring is. Idempotent. */
export function ensurePackageScripts(repoRoot: string, dryRun: boolean): string[] {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return [];
  let pkg: { scripts?: Record<string, string> };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
    pkg = JSON.parse(text) as { scripts?: Record<string, string> };
  } catch {
    return [];
  }
  // Pinned the same way the harness wiring is, through the one helper that owns the pin (DI-05).
  const wanted: Record<string, string> = {
    'di:index': npxCommand('index', '.'),
    'di:health': npxCommand('health', '.'),
    'di:serve': npxCommand('serve', '--port', '7331'),
    'di:retrieve': npxCommand('retrieve'),
  };
  pkg.scripts = pkg.scripts ?? {};
  const added = Object.keys(wanted).filter((key) => !(key in pkg.scripts!));
  if (added.length === 0) return [];
  if (dryRun) return added;

  for (const key of added) {
    const command = wanted[key];
    if (command) pkg.scripts[key] = command;
  }
  pkg.scripts = Object.fromEntries(
    Object.entries(pkg.scripts).sort((a, b) => a[0].localeCompare(b[0]))
  );
  // Keep the file's own indentation: reformatting a file the user owns would show up as a
  // whole-file diff in their next commit.
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
  writeFileSync(path, JSON.stringify(pkg, null, indent) + '\n');
  return added;
}

/**
 * Which instructions file to document deepindex in.
 *
 * Claude Code reads CLAUDE.md, the other harnesses read AGENTS.md — but a repository that
 * already has one of them has made its choice, and creating a second convention next to it
 * would be worse than appending to what is there.
 */
export function guidanceTarget(repoRoot: string, harness?: string): string {
  const preferred = harness === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md';
  const other = preferred === 'CLAUDE.md' ? 'AGENTS.md' : 'CLAUDE.md';
  if (existsSync(join(repoRoot, preferred))) return preferred;
  if (existsSync(join(repoRoot, other))) return other;
  return preferred;
}

/** Appends the guidance once. Returns the file it wrote, or null when it was already there. */
export function appendGuidance(
  repoRoot: string,
  harness?: string,
  dryRun = false
): string | null {
  const name = guidanceTarget(repoRoot, harness);
  const path = join(repoRoot, name);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (text.includes(GUIDANCE_MARKER)) return null;
  if (!dryRun) {
    const prefix = text === '' ? '' : `${text.replace(/\n*$/, '')}\n\n`;
    writeFileSync(path, `${prefix}${GUIDANCE}`);
  }
  return name;
}

/** The repo-level envelope: everything install does beyond harness wiring. */
export function scaffoldRepo(repoRoot: string, opts: ScaffoldOptions = {}): string[] {
  const dryRun = opts.dryRun === true;
  const actions: string[] = [];
  const label = (what: string) => (dryRun ? `would ${what}` : what);

  if (ensureRepoConfig(repoRoot, dryRun)) {
    actions.push(label('write .deepindex.toml'));
  }
  const ignored = ensureGitignore(repoRoot, dryRun);
  if (ignored.length > 0) {
    actions.push(label(`add ${ignored.join(', ')} to .gitignore`));
  }
  if (opts.scripts !== false) {
    const scripts = ensurePackageScripts(repoRoot, dryRun);
    if (scripts.length > 0) actions.push(label(`add npm scripts: ${scripts.join(', ')}`));
  }
  if (opts.guidance !== null && opts.guidance !== undefined) {
    const written = appendGuidance(repoRoot, opts.guidance, dryRun);
    if (written) actions.push(label(`document deepindex in ${written}`));
  }
  return actions;
}
