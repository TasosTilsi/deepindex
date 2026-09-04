// Phase 6: Additive MCP + hooks install into project .claude/settings.json (D-08).
// Merges, never clobbers existing settings.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface Settings {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
}

/** Additively install the deepindex MCP server + hooks into .claude/settings.json. */
export function installClaudeSettings(projectRoot: string): { path: string; mcpAdded: boolean; hooksAdded: boolean } {
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

  const mcpAdded = !settings.mcpServers?.deepindex;
  settings.mcpServers = {
    ...(settings.mcpServers ?? {}),
    deepindex: {
      command: 'deepindex',
      args: ['mcp', 'serve'],
    },
  };

  const hooksAdded = !settings.hooks?.SessionStart;
  settings.hooks = {
    ...(settings.hooks ?? {}),
    SessionStart: 'deepindex hook session-start',
    UserPromptSubmit: 'deepindex hook user-prompt-submit',
    PostToolUse: 'deepindex hook post-tool-use',
    SessionEnd: 'deepindex hook session-end',
  };

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return { path: settingsPath, mcpAdded, hooksAdded };
}
