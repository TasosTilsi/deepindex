import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';

// [semantic] / [hooks] config sections in .deepindex.toml — same
// regex-per-section pattern as loadConfig in health.ts (R5). Unknown values
// fall back to defaults without throwing (CONTEXT: config key naming edge
// cases; D-26b: semantic is opt-in so degradation is the default posture).

export interface SemanticConfig {
  enabled: boolean;
  model: 'minilm' | 'bge';
  /**
   * Absolute path to a local model directory (issue #6). When set, the embedder reads
   * the ONNX export from there instead of the fetched cache and makes no network
   * request at all — the offline/air-gapped path. Absent when unconfigured, so the
   * object shape is unchanged for everyone who does not use it.
   */
  modelPath?: string;
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
/** True when `target` is inside `root` (or is it). Prefix-safe: `relative` is not `startsWith`. */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

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
  // Quoted first: a path may contain spaces and a bare form may carry a comment.
  const pathMatch = block.match(/model_path\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
  const fromToml = (pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3])?.trim() || undefined;
  const fromEnv = process.env.DEEPINDEX_MODEL_PATH?.trim() || undefined;
  const rawPath = fromEnv ?? fromToml;

  const config: SemanticConfig = {
    enabled: enabledMatch ? enabledMatch[1] === 'true' : DEFAULT_SEMANTIC_CONFIG.enabled,
    model: modelMatch ? (modelMatch[1] as 'minilm' | 'bge') : DEFAULT_SEMANTIC_CONFIG.model,
  };
  if (rawPath) {
    // An environment value is relative to the cwd (a CI injection); a configured one
    // belongs to the repository, like every other path in this file.
    const base = fromEnv ? process.cwd() : repoPath;
    const resolved = isAbsolute(rawPath) ? normalize(rawPath) : resolve(base, rawPath);
    if (fromEnv || isInside(repoPath, resolved)) {
      config.modelPath = resolved;
    } else {
      // A repository is untrusted input, and its config can point the loader at any directory on
      // this machine — including one holding a model file it did not have to ship. The escape
      // hatch is the user's own environment variable, which the repository cannot set.
      console.error(
        `deepindex: [semantic] model_path resolves outside the repository (${resolved}) — ignoring it. Set DEEPINDEX_MODEL_PATH to point at a model directory of your own.`
      );
    }
  }
  return config;
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