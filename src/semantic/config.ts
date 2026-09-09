import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// [semantic] / [hooks] config sections in .deepindex.toml — same
// regex-per-section pattern as loadConfig in health.ts (R5). Unknown values
// fall back to defaults without throwing (CONTEXT: config key naming edge
// cases; D-26b: semantic is opt-in so degradation is the default posture).

export interface SemanticConfig {
  enabled: boolean;
  model: 'minilm' | 'bge';
}

export interface HooksConfig {
  sessionBudgetMs: number;
}

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  enabled: false,
  model: 'minilm',
};

export const DEFAULT_HOOKS_CONFIG: HooksConfig = { sessionBudgetMs: 10000 };

/** [semantic] section: `enabled = true|false`, `model = minilm|bge`. */
export function loadSemanticConfig(repoPath: string): SemanticConfig {
  const tomlPath = join(repoPath, '.deepindex.toml');
  if (!existsSync(tomlPath)) return { ...DEFAULT_SEMANTIC_CONFIG };
  let text: string;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch {
    return { ...DEFAULT_SEMANTIC_CONFIG };
  }
  const sectionMatch = text.match(/\[semantic\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return { ...DEFAULT_SEMANTIC_CONFIG };
  const block = sectionMatch[1] ?? '';
  const enabledMatch = block.match(/enabled\s*=\s*(true|false)/);
  const modelMatch = block.match(/model\s*=\s*(minilm|bge)/);
  return {
    enabled: enabledMatch ? enabledMatch[1] === 'true' : DEFAULT_SEMANTIC_CONFIG.enabled,
    model: modelMatch ? (modelMatch[1] as 'minilm' | 'bge') : DEFAULT_SEMANTIC_CONFIG.model,
  };
}

/** [hooks] section: `session_budget_ms = <int>` (D-26c, default 10000). */
export function loadHooksConfig(repoPath: string): HooksConfig {
  const tomlPath = join(repoPath, '.deepindex.toml');
  if (!existsSync(tomlPath)) return { ...DEFAULT_HOOKS_CONFIG };
  let text: string;
  try {
    text = readFileSync(tomlPath, 'utf8');
  } catch {
    return { ...DEFAULT_HOOKS_CONFIG };
  }
  const sectionMatch = text.match(/\[hooks\]([\s\S]*?)(?=\n\[|$)/);
  if (!sectionMatch) return { ...DEFAULT_HOOKS_CONFIG };
  const block = sectionMatch[1] ?? '';
  const budgetMatch = block.match(/session_budget_ms\s*=\s*(\d+)/);
  if (!budgetMatch) return { ...DEFAULT_HOOKS_CONFIG };
  const n = Number.parseInt(budgetMatch[1] ?? '', 10);
  if (!Number.isFinite(n) || n < 0) return { ...DEFAULT_HOOKS_CONFIG };
  return { sessionBudgetMs: n };
}