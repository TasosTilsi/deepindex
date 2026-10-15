import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendGuidance,
  askGuidance,
  backupFiles,
  ensureGitignore,
  ensurePackageScripts,
  ensureRepoConfig,
  existingTargets,
  guardClaudeSettings,
  guidanceTarget,
  scaffoldRepo,
  BACKUP_ROOT,
} from '../src/scaffold.js';

/**
 * The onboarding envelope, exercised directly.
 *
 * These functions were covered only through the CLI, which tests reach by spawning the real
 * binary in a child process — and v8 cannot instrument a child process, so `scaffold.ts` reported
 * 0 % line coverage while its behaviour was "covered" by spawns (issue #21). Testing them here
 * measures what was already asserted, and reaches the branches a spawn cannot: the prompt's
 * answers, the dry-run paths, and the guard's refusals.
 */
function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'deepindex-scaffold-'));
}

describe('install guidance prompt', () => {
  it('accepts y/yes in any case, and treats anything else as no', async () => {
    const question = vi.fn().mockResolvedValue('Y');
    const io = { isTTY: true, question };
    expect(await askGuidance('CLAUDE.md', io)).toBe(true);
    expect(question).toHaveBeenCalledOnce();

    question.mockResolvedValue('yes');
    expect(await askGuidance('CLAUDE.md', io)).toBe(true);

    question.mockResolvedValue('');
    expect(await askGuidance('CLAUDE.md', io)).toBe(false);

    question.mockResolvedValue('nope');
    expect(await askGuidance('CLAUDE.md', io)).toBe(false);
  });

  it('never asks when there is no terminal', async () => {
    const question = vi.fn().mockResolvedValue('y');
    expect(await askGuidance('AGENTS.md', { isTTY: false, question })).toBeNull();
    // The distinction that matters: "not asked" is not "answered no", and the CLI says so.
    expect(question).not.toHaveBeenCalled();
  });
});

describe('the guard before install writes anything', () => {
  it('refuses an unparseable .claude/settings.json instead of replacing it', () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, '.claude'), { recursive: true });
      writeFileSync(join(repo, '.claude', 'settings.json'), '{\n  // jsonc comment\n}\n');
      const guard = guardClaudeSettings(repo);
      expect(guard.blocked).toBe(true);
      expect(guard.message).toMatch(/not valid JSON/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('names the hook events it is about to replace', () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, '.claude'), { recursive: true });
      writeFileSync(
        join(repo, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { SessionStart: 'mine', PostToolUse: 'mine too' } })
      );
      expect(guardClaudeSettings(repo).warnings).toEqual([
        'these hooks already exist and will be replaced: SessionStart, PostToolUse',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('passes when there is nothing to guard', () => {
    const repo = tempRepo();
    try {
      expect(guardClaudeSettings(repo)).toEqual({ blocked: false, warnings: [] });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('backing up what install may rewrite', () => {
  it('copies only files that exist, and only under dry-run does it write nothing', () => {
    const repo = tempRepo();
    try {
      writeFileSync(join(repo, 'package.json'), '{"name":"demo"}\n');
      expect(existingTargets(repo)).toEqual(['package.json']);

      const dir = backupFiles(repo, existingTargets(repo), false);
      expect(dir).toContain(BACKUP_ROOT);
      expect(readFileSync(join(dir!, 'package.json'), 'utf8')).toBe('{"name":"demo"}\n');

      const dry = backupFiles(repo, ['package.json'], true);
      expect(dry).toContain(BACKUP_ROOT);
      expect(existsSync(dry!)).toBe(false);

      expect(backupFiles(repo, [], false)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the files install creates or edits', () => {
  it('adds the index artifact to .gitignore once, keeping the existing file', () => {
    const repo = tempRepo();
    try {
      writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
      const added = ensureGitignore(repo, false);
      expect(added).toEqual(['.deepindex.db', '.deepindex.db-*', `${BACKUP_ROOT}/`]);

      const text = readFileSync(join(repo, '.gitignore'), 'utf8');
      expect(text).toContain('node_modules');
      expect(text).toContain('.deepindex.db');

      // Idempotent: a second call adds nothing and leaves the file byte-identical.
      expect(ensureGitignore(repo, false)).toEqual([]);
      expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(text);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('creates .deepindex.toml once and never touches an existing one', () => {
    const repo = tempRepo();
    try {
      expect(ensureRepoConfig(repo, false)).toBe(true);
      const text = readFileSync(join(repo, '.deepindex.toml'), 'utf8');
      expect(text).toContain('[semantic]');

      writeFileSync(join(repo, '.deepindex.toml'), '[health]\nrepair_below = 50\n');
      expect(ensureRepoConfig(repo, false)).toBe(false);
      expect(readFileSync(join(repo, '.deepindex.toml'), 'utf8')).toBe('[health]\nrepair_below = 50\n');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('adds the di:* scripts with the repository own indentation, and only once', () => {
    const repo = tempRepo();
    try {
      writeFileSync(join(repo, 'package.json'), '{\n    "name": "demo"\n}\n');
      expect(ensurePackageScripts(repo, false)).toEqual([
        'di:index',
        'di:health',
        'di:serve',
        'di:retrieve',
      ]);
      const text = readFileSync(join(repo, 'package.json'), 'utf8');
      expect(text.startsWith('{\n    "name"')).toBe(true);
      expect(text).toMatch(/"di:index": "npx -y deepindex@\d+\.\d+\.\d+ index \."/);

      expect(ensurePackageScripts(repo, false)).toEqual([]);
      expect(readFileSync(join(repo, 'package.json'), 'utf8')).toBe(text);

      // No package.json, nothing to edit.
      const bare = tempRepo();
      expect(ensurePackageScripts(bare, false)).toEqual([]);
      rmSync(bare, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('picks the instructions file the harness reads, reusing whichever exists', () => {
    const repo = tempRepo();
    try {
      expect(guidanceTarget(repo, 'claude-code')).toBe('CLAUDE.md');
      expect(guidanceTarget(repo, 'codex')).toBe('AGENTS.md');
      // A repository that already has the other convention keeps it.
      writeFileSync(join(repo, 'AGENTS.md'), '# House rules\n');
      expect(guidanceTarget(repo, 'claude-code')).toBe('AGENTS.md');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('appends the guidance once, and writes nothing under dry-run', () => {
    const repo = tempRepo();
    try {
      expect(appendGuidance(repo, 'codex')).toBe('AGENTS.md');
      const text = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
      expect(text).toContain('deepindex:retrieval-nudge');
      expect(appendGuidance(repo, 'codex')).toBeNull();

      const dry = tempRepo();
      expect(appendGuidance(dry, 'codex', true)).toBe('AGENTS.md');
      expect(existsSync(join(dry, 'AGENTS.md'))).toBe(false);
      rmSync(dry, { recursive: true, force: true });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('the envelope as a whole', () => {
  it('reports what it would do under dry-run and writes none of it', () => {
    const repo = tempRepo();
    try {
      writeFileSync(join(repo, 'package.json'), '{"name":"demo"}\n');
      const actions = scaffoldRepo(repo, { dryRun: true, guidance: 'codex' });
      expect(actions).toEqual([
        'would write .deepindex.toml',
        'would add .deepindex.db, .deepindex.db-*, .deepindex-backup/ to .gitignore',
        'would add npm scripts: di:index, di:health, di:serve, di:retrieve',
        'would document deepindex in AGENTS.md',
      ]);
      for (const rel of ['.deepindex.toml', '.gitignore', 'AGENTS.md']) {
        expect(existsSync(join(repo, rel)), rel).toBe(false);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not touch the guidance when it was declined', () => {
    const repo = tempRepo();
    try {
      const actions = scaffoldRepo(repo, { guidance: null });
      expect(actions.some((a) => a.includes('AGENTS.md'))).toBe(false);
      expect(existsSync(join(repo, 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
