// Phase 6: UserPromptSubmit hook — context injection (HOOK-02, FTS-first, ≤6s).

import { adaptClaudeCode } from '../adapter-claude-code.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface HookResult {
  ok: boolean;
  message: string;
}

/** UserPromptSubmit: inject merged context (symbols + data-flow + entities) for the task. */
export async function userPromptSubmit(
  task: string,
  repoPath: string,
  dbPath = '.ctx.db'
): Promise<HookResult> {
  const absRepo = resolve(repoPath);
  if (!existsSync(absRepo)) return { ok: false, message: `repo not found: ${absRepo}` };
  try {
    const result = await adaptClaudeCode(task, absRepo, { dbPath });
    return {
      ok: true,
      message: JSON.stringify({
        topFiles: result.topFiles.map((f) => f.path),
        entities: result.entities?.map((e) => `${e.type}:${e.name}`) ?? [],
        health: result.health.score,
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  }
}
