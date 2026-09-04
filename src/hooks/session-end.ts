// Phase 6: SessionEnd hook — write session summary (HOOK-03). Deterministic.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HookResult {
  ok: boolean;
  message: string;
}

/** SessionEnd: write a session summary file. */
export function sessionEnd(
  sessionId: string,
  summary: string,
  logDir = '.deepindex'
): HookResult {
  try {
    mkdirSync(logDir, { recursive: true });
    const path = join(logDir, `session-${sessionId}.md`);
    writeFileSync(path, `# Session ${sessionId}\n\n${summary}\n`);
    return { ok: true, message: `wrote session summary: ${path}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
