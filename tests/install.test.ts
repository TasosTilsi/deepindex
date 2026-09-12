import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { installCodex, installOpenCode, installHarness, installDsh } from '../src/install.js';

const VERSION = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version;
const PIN = `deepindex@${VERSION}`;

describe('multi-harness install', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deepindex-install-'));
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
    // DI-05: pinned npx, version read from package.json at install time.
    expect(config.command).toBe('npx');
    expect(config.args).toEqual(['-y', PIN, 'mcp', 'serve']);
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

// DI-05: every generated command must be pinned `npx -y deepindex@<version>`
// (version read from package.json at install time) so pinned-npx consumers
// don't break when a bare-npx cache path rotates. Claude Code's MCP entry
// moves to the project-shareable root .mcp.json; OpenCode gains an
// mcp.<name> entry in opencode.json alongside the existing plugin.
describe('pinned npx install commands (DI-05)', () => {
  it('claude-code install writes the MCP server into root .mcp.json with pinned npx', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-mcpjson-'));
    const r = installHarness(d, 'claude-code');
    expect(r.ok).toBe(true);
    const mcp = JSON.parse(readFileSync(join(d, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.deepindex.command).toBe('npx');
    expect(mcp.mcpServers.deepindex.args).toEqual(['-y', PIN, 'mcp', 'serve']);
    rmSync(d, { recursive: true, force: true });
  });

  it('claude-code install keeps hooks in settings.json with pinned commands and no mcpServers', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-claudepin-'));
    installHarness(d, 'claude-code');
    const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toBe(`npx -y ${PIN} hook session-start`);
    expect(settings.hooks.UserPromptSubmit).toBe(`npx -y ${PIN} hook user-prompt-submit`);
    expect(settings.hooks.PostToolUse).toBe(`npx -y ${PIN} hook post-tool-use`);
    expect(settings.hooks.SessionEnd).toBe(`npx -y ${PIN} hook session-end`);
    // Fresh installs stop writing mcpServers into settings.json — that entry
    // now lives in the project-shareable .mcp.json.
    expect(settings.mcpServers).toBeUndefined();
    rmSync(d, { recursive: true, force: true });
  });

  it('claude-code install preserves a pre-existing settings.json mcpServers entry (additive)', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-claudekeep-'));
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(
      join(d, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } })
    );
    installHarness(d, 'claude-code');
    const settings = JSON.parse(readFileSync(join(d, '.claude', 'settings.json'), 'utf8'));
    expect(settings.mcpServers.other.command).toBe('x');
    rmSync(d, { recursive: true, force: true });
  });

  it('installCodex writes pinned npx into config.toml and hooks.json', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-codexpin-'));
    installCodex(d);
    const config = readFileSync(join(d, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('command = "npx"');
    expect(config).toContain(`"${PIN}"`);
    const hooks = JSON.parse(readFileSync(join(d, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(`npx -y ${PIN} hook session-start`);
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toBe(`npx -y ${PIN} hook session-end`);
    rmSync(d, { recursive: true, force: true });
  });

  it('installOpenCode writes an mcp.deepindex entry into opencode.json and pins the plugin command', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-ocpin-'));
    installOpenCode(d);
    const oc = JSON.parse(readFileSync(join(d, 'opencode.json'), 'utf8'));
    expect(oc.mcp.deepindex.type).toBe('local');
    expect(oc.mcp.deepindex.command).toEqual(['npx', '-y', PIN, 'mcp', 'serve']);
    const plugin = readFileSync(join(d, '.opencode', 'plugins', 'deepindex', 'index.ts'), 'utf8');
    expect(plugin).toContain(`npx -y ${PIN}`);
    rmSync(d, { recursive: true, force: true });
  });

  it('installOpenCode merges into an existing opencode.json additively', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-ocmerge-'));
    writeFileSync(join(d, 'opencode.json'), JSON.stringify({ theme: 'dark' }));
    installOpenCode(d);
    const oc = JSON.parse(readFileSync(join(d, 'opencode.json'), 'utf8'));
    expect(oc.theme).toBe('dark');
    expect(oc.mcp.deepindex.command).toEqual(['npx', '-y', PIN, 'mcp', 'serve']);
    rmSync(d, { recursive: true, force: true });
  });

  it('installOpenCode leaves an unparseable opencode.json untouched (never clobbers)', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-ocbad-'));
    const garbage = '{ "theme": "dark", trailing garbage';
    writeFileSync(join(d, 'opencode.json'), garbage);
    const r = installOpenCode(d);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(garbage);
    rmSync(d, { recursive: true, force: true });
  });

  it('installDsh pins npx -y deepindex@VERSION in the MCP entry', () => {
    const d = mkdtempSync(join(tmpdir(), 'deepindex-dshpin-'));
    const configPath = join(d, 'cordis.patch.yml');
    installDsh(configPath);
    const entries = yamlLoad(readFileSync(configPath, 'utf8')) as Array<Record<string, unknown>>;
    const deepindex = entries.find((e) => e.id === 'mcp-deepindex')!;
    const config = deepindex.config as Record<string, unknown>;
    expect(config.command).toBe('npx');
    expect(config.args).toEqual(['-y', PIN, 'mcp', 'serve']);
    rmSync(d, { recursive: true, force: true });
  });
});
