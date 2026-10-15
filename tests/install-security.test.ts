import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installHarness } from '../src/install.js';

/**
 * The install path writes into a repository the user cloned, which means a repository can plant the
 * targets: a symlinked `.claude/settings.json` pointing at `~/.bashrc`, or a config it cannot parse.
 * Two rules follow, and both were missing outside the new `install` verb.
 */
function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'deepindex-install-sec-'));
}

describe('the OpenCode plugin it generates', () => {
  it('runs the CLI through argv, never through a shell string', () => {
    const repo = tempRepo();
    try {
      installHarness(repo, 'opencode');
      const plugin = readFileSync(
        join(repo, '.opencode', 'plugins', 'deepindex', 'index.ts'),
        'utf8'
      );
      // The session id reaches `run([...])`; with `execSync("<cmd> " + args.join(" "))` that is a
      // command injection inside the user's editor.
      expect(plugin).toContain('execFileSync');
      expect(plugin).not.toMatch(/execSync\(/);
      expect(plugin).toMatch(/execFileSync\("npx", \["-y", "deepindex@[^"]+", \.\.\.args\]/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('a repository that plants the install targets', () => {
  it('refuses to write through a symlinked settings file instead of following it', () => {
    const repo = tempRepo();
    const outside = join(repo, '..', `victim-${Date.now()}.txt`);
    const victim = join(repo, '.claude', 'settings.json');
    try {
      writeFileSync(outside, 'ORIGINAL\n');
      mkdirSync(join(repo, '.claude'), { recursive: true });
      symlinkSync(outside, victim);

      const result = installHarness(repo, 'claude-code');
      // Refused, and the file the link pointed at is untouched.
      expect(result.message).toMatch(/symlink|refus/i);
      expect(readFileSync(outside, 'utf8')).toBe('ORIGINAL\n');
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  it('refuses an unparseable settings file and keeps whatever was in it', () => {
    const repo = tempRepo();
    try {
      mkdirSync(join(repo, '.claude'), { recursive: true });
      const jsonc = '{\n  // a comment\n  "hooks": { "SessionStart": "mine" }\n}\n';
      writeFileSync(join(repo, '.claude', 'settings.json'), jsonc);

      const result = installHarness(repo, 'claude-code');
      expect(result.message).toMatch(/not valid JSON/);
      // The old behaviour replaced the whole file with `{}` — this is the guard that exists for it,
      // now reached from the harness installer too, not only from `deepindex install`.
      expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe(jsonc);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
