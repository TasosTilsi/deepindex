// Phase 2: Repair — 4-stage pipeline. Deterministic first; LLM last.
// Stage 1: rebuild graph. Stage 2: invalidate stale cache. Stage 3: git history probe.
// Stage 4 (defined in task 2.8): LLM call with response cache.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { buildGraph } from './graph/build.js';
import { cacheDelete, cacheGet, cacheSet } from './cache.js';
import { getHealth, loadConfig, DEFAULT_HEALTH_CONFIG } from './health.js';
import { sha256 } from './fingerprint.js';
import type { HealthConfig, RepairCost, RepairStageResult } from './types.js';

export const REPAIR_CACHE_PREFIX = 'repair:';

export function repairCacheKey(prompt: string): string {
  return REPAIR_CACHE_PREFIX + sha256(prompt);
}

export async function stage1Rebuild(
  db: Database.Database,
  repoPath: string
): Promise<RepairStageResult> {
  const stats = await buildGraph(db, repoPath);
  if (stats.fileCount > 0) {
    return {
      ok: true,
      actions: [`rebuilt ${stats.fileCount} files`],
    };
  }
  return {
    ok: true,
    actions: ['no changes; rebuild was a no-op'],
  };
}

export function stage2CacheInvalidate(
  db: Database.Database
): RepairStageResult {
  const rows = db
    .prepare(`SELECT key FROM cache WHERE key LIKE 'repair:%' OR key LIKE 'summary:%'`)
    .all() as { key: string }[];
  let invalidated = 0;
  for (const r of rows) {
    try {
      cacheDelete(db, r.key);
      invalidated++;
    } catch {
      return {
        ok: false,
        actions: [`failed to delete ${r.key}`],
      };
    }
  }
  return {
    ok: true,
    actions: [`invalidated ${invalidated} cache entries`],
  };
}

const SCAN_EXTS = new Set(['.ts', '.js']);
const CLAIM_RE = /^\s*\/\/\s*CLAIM:\s*(.+)$/;

export function stage3GitHistory(
  repoPath: string,
  opts: { maxFiles?: number; maxBytes?: number } = {}
): RepairStageResult {
  const gitDir = join(repoPath, '.git');
  if (!existsSync(gitDir)) {
    return { ok: false, actions: ['no .git directory; stage 3 skipped'] };
  }
  const maxFiles = opts.maxFiles ?? 10;
  const maxBytes = opts.maxBytes ?? 1024 * 1024;
  const srcDir = join(repoPath, 'src');
  if (!existsSync(srcDir)) {
    return { ok: false, actions: ['no src directory; stage 3 skipped'] };
  }
  const files = walkTsJs(srcDir).slice(0, maxFiles);
  const contradictions: string[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const claims: { line: string; text: string }[] = [];
    for (const l of lines) {
      const m = l.match(CLAIM_RE);
      if (m && m[1]) claims.push({ line: l, text: m[1].trim() });
    }
    if (claims.length === 0) continue;
    let log = '';
    try {
      log = execFileSync('git', ['log', '-p', '--', file], {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: maxBytes,
      });
    } catch {
      continue;
    }
    for (const claim of claims) {
      if (contradicts(log, claim.text)) {
        contradictions.push(
          `doc claim "${claim.text}" contradicted by recent git history`
        );
      }
    }
  }
  if (contradictions.length > 0) {
    return { ok: true, actions: contradictions };
  }
  return { ok: false, actions: ['no contradictions found'] };
}

function contradicts(log: string, claim: string): boolean {
  // Heuristic: if any diff hunk removes a line containing the claim text,
  // the claim is contradicted. A removed line in `git log -p` output is
  // prefixed with '-'.
  const lines = log.split('\n');
  const claimLower = claim.toLowerCase();
  for (const l of lines) {
    if (!l.startsWith('-')) continue;
    if (l.toLowerCase().includes(claimLower)) return true;
  }
  return false;
}

function walkTsJs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        const i = name.lastIndexOf('.');
        const ext = i < 0 ? '' : name.slice(i);
        if (SCAN_EXTS.has(ext)) out.push(full);
      }
    }
  }
  return out;
}

export interface RepairOptions {
  llm?: LLMClient;
  config?: HealthConfig;
}

// stage4LLM: real implementation. Checks cacheGet(repairCacheKey(prompt)) first;
// on miss, calls llm.complete() and cacheSet() the response. On throw, returns
// ok:false without rethrowing.
export async function stage4LLM(
  db: Database.Database,
  llm: LLMClient,
  prompt: string
): Promise<RepairStageResult & { cost: RepairCost }> {
  const key = repairCacheKey(prompt);
  const hit = cacheGet(db, key);
  if (hit) {
    let parsed: { content: string; cost: RepairCost };
    try {
      parsed = JSON.parse(hit.content);
    } catch {
      parsed = { content: hit.content, cost: { prompt: 0, completion: 0 } };
    }
    return {
      ok: true,
      actions: [`llm cache hit; saved ${parsed.cost.completion} completion tokens`],
      cost: parsed.cost,
    };
  }
  try {
    const result = await llm.complete(prompt);
    const cost: RepairCost = {
      prompt: result.usage.prompt_tokens,
      completion: result.usage.completion_tokens,
    };
    cacheSet(db, key, JSON.stringify({ content: result.content, cost }), {});
    return {
      ok: true,
      actions: [`llm call succeeded; ${cost.prompt + cost.completion} tokens`],
      cost,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      actions: [`llm call failed: ${message}`],
      cost: { prompt: 0, completion: 0 },
    };
  }
}

export interface LLMClient {
  complete(
    prompt: string
  ): Promise<{ content: string; usage: { prompt_tokens: number; completion_tokens: number } }>;
}

export function OpenAICompatibleClient(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): LLMClient {
  return {
    async complete(prompt) {
      const url = opts.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + opts.apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error('LLM ' + res.status + ': ' + text);
      }
      const json = (await res.json()) as {
        choices: { message: { content: string } }[];
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      const content = json.choices[0]?.message.content ?? '';
      return {
        content,
        usage: {
          prompt_tokens: json.usage.prompt_tokens,
          completion_tokens: json.usage.completion_tokens,
        },
      };
    },
  };
}

export async function repair(
  db: Database.Database,
  repoPath: string,
  opts: RepairOptions = {}
): Promise<{ stages: RepairStageResult[]; llmCost?: RepairCost }> {
  const config = opts.config ?? loadConfig(repoPath) ?? DEFAULT_HEALTH_CONFIG;
  const stages: RepairStageResult[] = [];

  stages.push(await stage1Rebuild(db, repoPath));
  let report = getHealth(db, { config });
  if (report.score >= config.repairBelow) return { stages };

  stages.push(stage2CacheInvalidate(db));
  report = getHealth(db, { config });
  if (report.score >= config.repairBelow) return { stages };

  stages.push(stage3GitHistory(repoPath));
  report = getHealth(db, { config });
  if (report.score >= config.repairBelow) return { stages };

  if (opts.llm) {
    const prompt = buildLLMPrompt(report);
    const r = await stage4LLM(db, opts.llm, prompt);
    stages.push(r);
    return { stages, llmCost: r.cost };
  }

  return { stages };
}

function buildLLMPrompt(report: { score: number; dimensions: Record<string, number>; issues: { type: string; message: string; location?: string }[] }): string {
  return (
    'ContextKit repair request. Repo state:\n' +
    JSON.stringify(report, null, 2) +
    '\nRecent issues:\n' +
    JSON.stringify(report.issues, null, 2) +
    '\nSuggest a minimal fix.'
  );
}
