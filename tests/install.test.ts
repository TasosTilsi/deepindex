import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { installCodex, installOpenCode, installHarness, installDsh } from '../src/install.js';

describe('multi-harness install', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-install-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('installCodex writes .codex/hooks.json with 4 hooks + config.toml MCP', () => {
    const r = installCodex(dir);
    expect(r.ok).toBe(true);
    const hooks = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'));
    expect(Object.keys(hooks.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'SessionEnd'])
    );
    const config = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('[mcp_servers.deepindex]');
  });

  it('installCodex merges MCP into existing config.toml (additive)', () => {
    const dir2 = join(dir, 'codex2');
    mkdirSync(join(dir2, '.codex'), { recursive: true });
    writeFileSync(join(dir2, '.codex', 'config.toml'), '[model]\nprovider = "openai"\n');
    installCodex(dir2);
    const config = readFileSync(join(dir2, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('[model]');
    expect(config).toContain('[mcp_servers.deepindex]');
  });

  it('installOpenCode writes .opencode/plugins/deepindex/index.ts', () => {
    const r = installOpenCode(dir);
    expect(r.ok).toBe(true);
    const pluginPath = join(dir, '.opencode', 'plugins', 'deepindex', 'index.ts');
    expect(existsSync(pluginPath)).toBe(true);
    const src = readFileSync(pluginPath, 'utf8');
    expect(src).toContain('@opencode-ai/plugin');
    expect(src).toContain('session.created');
  });

  it('installHarness dispatches to the right installer', () => {
    const claude = installHarness(dir, 'claude-code');
    expect(claude.ok).toBe(true);
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    const codex = installHarness(dir, 'codex');
    expect(codex.harness).toBe('codex');
    const opencode = installHarness(dir, 'opencode');
    expect(opencode.harness).toBe('opencode');
  });

  it('installDsh writes a dsh-mcp-client entry to the DSH config (additive)', () => {
    const configPath = join(dir, 'dsh', 'cordis.patch.yml');
    const r = installDsh(configPath);
    expect(r.ok).toBe(true);
    const entries = yamlLoad(readFileSync(configPath, 'utf8')) as Array<Record<string, unknown>>;
    const deepindex = entries.find((e) => e.id === 'mcp-deepindex');
    expect(deepindex).toBeTruthy();
    const config = deepindex!.config as Record<string, unknown>;
    expect(config.serverName).toBe('deepindex');
    expect(config.transport).toBe('stdio');
    expect(config.command).toBe('deepindex');
    expect(config.args).toEqual(['mcp', 'serve']);
  });

  it('installDsh is idempotent (no duplicate entries)', () => {
    const configPath = join(dir, 'dsh2', 'cordis.patch.yml');
    installDsh(configPath);
    installDsh(configPath);
    const entries = yamlLoad(readFileSync(configPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(entries.filter((e) => e.id === 'mcp-deepindex').length).toBe(1);
  });

  it('installDsh merges into an existing config without clobbering', () => {
    const configPath = join(dir, 'dsh3', 'cordis.patch.yml');
    mkdirSync(join(dir, 'dsh3'), { recursive: true });
    writeFileSync(configPath, '- id: mcp-serena\n  name: "@deepseek-ai/dsh-mcp-client"\n');
    installDsh(configPath);
    const entries = yamlLoad(readFileSync(configPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(entries.some((e) => e.id === 'mcp-serena')).toBe(true);
    expect(entries.some((e) => e.id === 'mcp-deepindex')).toBe(true);
  });
});
