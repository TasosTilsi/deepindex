// Phase 6: PostToolUse hook — capture tool calls (HOOK-03). Records tool usage
// to a session log. Deterministic, no LLM.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HookResult {
  ok: boolean;
  message: string;
}

/** PostToolUse: append a tool-call record to the session log. */
export function postToolUse(
  toolName: string,
  sessionId: string,
  logDir = '.deepindex'
): HookResult {
  try {
    mkdirSync(logDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), sessionId, tool: toolName });
    appendFileSync(join(logDir, 'tool-use.log'), line + '\n');
    return { ok: true, message: `captured tool use: ${toolName}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
