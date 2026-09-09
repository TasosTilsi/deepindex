// Phase 8: SessionStart auto-chain (HOOK-04, D-26c) — git-sync → incremental
// re-index → staleness-gated lazy re-embed → deterministic auto-repair, capped
// by hooks.session_budget_ms (default 10000). D-29 (D-04 revised for
// sessionStart ONLY): sessionStart is the ONLY auto-sync/auto-embed/auto-repair
// point in the codebase. The watcher stays invalidate-only — src/watcher.ts is
// deliberately NOT touched by this module and nothing here wires into it;
// manual repair remains the watcher's path. D-06: the repair step NEVER passes
// an LLM client — repair() runs deterministic stages 1-3 only; stage 4 stays
// manual/optional.

import { initDb } from '../graph/db.js';
import { gitSync } from '../git/indexer.js';
import { buildGraph } from '../graph/build.js';
import { stalenessScan, embed } from '../semantic/embed.js';
import { loadHooksConfig, loadSemanticConfig, DEFAULT_SEMANTIC_CONFIG } from '../semantic/config.js';
import { hasCachedModel, resolveModelName, type Embedder } from '../semantic/embedder.js';
import { getHealth, loadConfig } from '../health.js';
import { repair } from '../repair.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

export interface HookResult {
  ok: boolean;
  message: string;
}

export interface SessionStartOptions {
  /** Budget override; default = [hooks] session_budget_ms (10000). */
  budgetMs?: number;
  /** Fake/injected embedder (D-24b) — short-circuits the loader. */
  embedder?: Embedder;
  /** Loader-spy injection (HOOK-04 acceptance: unchanged sessions must never
   *  reach it). */
  loader?: (m: string) => Promise<Embedder>;
  /** Injectable clock for budget tests. */
  now?: () => number;
}

/** SessionStart chain, in order (git-sync first, D-26c):
 *  (1) gitSync — incremental commit ingestion (cursor-guarded);
 *  (2) buildGraph — incremental hash-diff re-index;
 *  (3) stalenessScan → re-embed only if stale docs remain AND the budget has
 *      not expired. The model loads lazily here and only here; expiry defers
 *      the re-embed with ok:true (cursor/hash guards make deferral safe).
 *  (4) getHealth → if score < [health] repair_below, repair(db, absRepo) with
 *      NO llm client (deterministic stages 1-3; repair() is health-gated per
 *      stage internally). Budget expiry defers the health check safely.
 *  Any embed/ONNX failure is caught: ok stays true, index results survive
 *  (RSK-4); a repair failure is caught the same way. */
export async function sessionStart(
  repoPath: string,
  dbPath = '.deepindex.db',
  opts: SessionStartOptions = {}
): Promise<HookResult> {
  const absRepo = resolve(repoPath);
  if (!existsSync(absRepo)) return { ok: false, message: `repo not found: ${absRepo}` };
  const db = initDb(dbPath);
  const now = opts.now ?? Date.now;
  const budgetMs = opts.budgetMs ?? loadHooksConfig(absRepo).sessionBudgetMs;
  const start = now();
  const elapsed = () => now() - start;
  const parts: string[] = [];
  try {
    // Step 1: git sync (sync, deterministic, cursor-guarded).
    const r = gitSync(db, absRepo);
    parts.push(`git sync: ${r.commitsProcessed} commits, ${r.entitiesInserted} entities inserted`);

    // Step 2: incremental re-index (buildGraph hash-diff). Always applied —
    // deterministic and cheap for unchanged repos.
    const stats = await buildGraph(db, absRepo);
    parts.push(`indexed ${stats.fileCount} files, ${stats.symbolCount} symbols`);

    // Step 3: budget-gated staleness-first re-embed (lazy model load, D-26c).
    // REVIEW-FIX W1: the auto-embed step is GATED before any work — a default
    // install (semantic disabled, or model never fetched) pays neither the
    // corpus scan nor vec-table writes nor refusal noise on every session
    // (D-26b: auto-embed only when semantic.enabled AND model cached).
    if (elapsed() < budgetMs) {
      const cfg = loadSemanticConfig(absRepo) ?? DEFAULT_SEMANTIC_CONFIG;
      if (cfg.enabled && hasCachedModel(resolveModelName(cfg))) {
        try {
          const scan = stalenessScan(db, absRepo);
          if (scan.stale.length > 0) {
            const res = await embed(db, {
              rootDir: absRepo,
              embedder: opts.embedder,
              loader: opts.loader,
            });
            parts.push(`embedded ${res.embedded}, skipped ${res.skipped}`);
          } else {
            parts.push('embeddings up to date');
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          parts.push(`embed failed: ${message}`);
        }
      } else {
        // Silent skip — the hint lives in the embed verb and the dashboard
        // status card; sessions must stay quiet for default installs (REVIEW
        // finding 1: refusal noise on every session was a regression).
      }
    } else {
      parts.push(
        `session budget (${budgetMs}ms) expired — re-embed deferred (safe: hash/cursor guards resume it next session)`
      );
    }

    // Step 4: deterministic auto-repair, budget-gated like the other steps
    // (D-29: sessionStart is the ONLY auto-repair point; D-06: NO llm client
    // is ever passed — repair() runs stages 1-3 only, stage 4 stays manual).
    // Expiry defers the check safely: health is re-scored next session.
    if (elapsed() < budgetMs) {
      const hcfg = loadConfig(absRepo);
      const report = getHealth(db, { config: hcfg });
      if (report.score < hcfg.repairBelow) {
        try {
          const rr = await repair(db, absRepo, { config: hcfg });
          parts.push(`auto-repair: ${rr.stages.length} stages run`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          parts.push(`auto-repair failed: ${message}`);
        }
      } else {
        parts.push(`health OK (score ${report.score} >= threshold ${hcfg.repairBelow})`);
      }
    }
    return { ok: true, message: parts.join('; ') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message };
  } finally {
    db.close();
  }
}