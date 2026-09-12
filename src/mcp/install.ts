// Phase 6: Additive MCP + hooks install into project config (D-08, DI-05).
// Merges, never clobbers existing settings. The MCP server entry lives in the
// project-shareable root .mcp.json (Claude Code convention, DI-05b); hooks
// stay in .claude/settings.json. Every generated command is pinned
// `npx -y deepindex@<version>` (DI-05a) so pinned-npx consumers never break
// when a bare-npx cache path rotates.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { npxArgs, npxCommand } from '../version.js';

interface Settings {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

/** Additively install the deepindex MCP server into root .mcp.json and the
 *  hooks into .claude/settings.json. Pre-existing config is never deleted —
 *  a stale settings.json mcpServers block is left in place (notable, but
 *  removing user config would violate the additive discipline). */
export function installClaudeSettings(projectRoot: string): { path: string; mcpAdded: boolean; hooksAdded: boolean } {
  // --- MCP server → project-shareable root .mcp.json (DI-05b) ---
  mkdirSync(projectRoot, { recursive: true });
  const mcpJsonPath = join(projectRoot, '.mcp.json');
  let mcp: { mcpServers?: Record<string, unknown> } = {};
  let mcpWritable = true;
  if (existsSync(mcpJsonPath)) {
    try {
      mcp = JSON.parse(readFileSync(mcpJsonPath, 'utf8')) as typeof mcp;
    } catch {
      // Unparseable .mcp.json (JSONC etc.) — never clobber; skip the entry.
      mcpWritable = false;
    }
  }
  const mcpAdded = mcpWritable && !mcp.mcpServers?.deepindex;
  if (mcpWritable) {
    mcp.mcpServers = {
      ...(mcp.mcpServers ?? {}),
      deepindex: { command: 'npx', args: npxArgs('mcp', 'serve') },
    };
    writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + '\n');
  }

  // --- Hooks → .claude/settings.json (no mcpServers written here on fresh
  // installs — that entry moved to .mcp.json; pre-existing blocks untouched) ---
  const claudeDir = join(projectRoot, '.claude');
  const settingsPath = join(claudeDir, 'settings.json');
  mkdirSync(claudeDir, { recursive: true });

  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
    } catch {
      settings = {};
    }
  }

  const hooksAdded = !settings.hooks?.SessionStart;
  settings.hooks = {
    ...(settings.hooks ?? {}),
    SessionStart: npxCommand('hook', 'session-start'),
    UserPromptSubmit: npxCommand('hook', 'user-prompt-submit'),
    PostToolUse: npxCommand('hook', 'post-tool-use'),
    SessionEnd: npxCommand('hook', 'session-end'),
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { path: settingsPath, mcpAdded, hooksAdded };
}