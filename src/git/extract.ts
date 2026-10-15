// Phase 5: Entity extraction — deterministic heuristic (required) + LLM batch
// (optional enrichment, D-06/D-08). 8 refined types (D-15).

import type { CommitRecord } from './walker.js';
import { sanitizeDiff } from './sanitize.js';
import type { LLMClient } from '../repair.js';
import { createHash } from 'node:crypto';

export const ENTITY_TYPES = [
  'decision',
  'bug_fix',
  'pattern',
  'tech_debt',
  'concept',
  'breaking_change',
  'security_fix',
  'workflow',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export interface EntityRecord {
  type: EntityType;
  name: string;
  content: string;
  commitSha: string;
}

export interface RelationshipRecord {
  from: string; // entity id (UUID5 type:name)
  to: string;
  relationship: 'fixes' | 'implements' | 'depends_on' | 'relates_to' | 'breaks';
  context: string;
}

export interface ExtractionResult {
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
}

// Keyword → type heuristics over commit subject + changed paths.
// Order matters: more specific types (security_fix, breaking_change) first.
const TYPE_KEYWORDS: Array<{ type: EntityType; re: RegExp }> = [
  { type: 'security_fix', re: /\b(security|cve|vuln|vulnerab|exploit|xss|csrf|injection|sanitize)\b/i },
  { type: 'breaking_change', re: /\b(breaking|breaking-change|deprecat|major|migrat|remove|removed|rename|renamed|incompatib)\b/i },
  { type: 'bug_fix', re: /\b(fix|fixes|fixed|bug|bugfix|hotfix|patch|correct|resolve|resolves)\b/i },
  { type: 'tech_debt', re: /\b(todo|hack|workaround|debt|temporary|temp|quick fix|kludge|refactor later)\b/i },
  { type: 'decision', re: /\b(decision|decide|choose|chose|standardize|standard|adopt|adopted|rationale|why)\b/i },
  { type: 'pattern', re: /\b(pattern|refactor|extract|introduce|implement|add|feat|feature|new)\b/i },
  { type: 'workflow', re: /\b(workflow|ci|cd|pipeline|release|deploy|process|automation)\b/i },
  { type: 'concept', re: /\b(concept|domain|model|entity|notion|idea|design)\b/i },
];

/** Classify a commit into an entity type by keyword heuristics. */
export function classifyType(message: string, files: string[]): EntityType {
  const haystack = `${message} ${files.join(' ')}`;
  for (const { type, re } of TYPE_KEYWORDS) {
    if (re.test(haystack)) return type;
  }
  return 'concept';
}

/** Derive a stable entity name from the commit subject (kebab-case, lowercase). */
export function deriveName(message: string): string {
  const cleaned = message
    .replace(/^(feat|fix|refactor|docs|chore|perf|security|test|build|ci|style|revert)(\([^)]*\))?:\s*/i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return cleaned || 'untitled';
}

/** Deterministic extraction: one entity per commit, typed by heuristics. */
export function extractDeterministic(commit: CommitRecord): ExtractionResult {
  const type = classifyType(commit.message, commit.filesChanged);
  const name = deriveName(commit.message);
  const content = `${commit.message} — files: ${commit.filesChanged.join(', ') || 'none'}`;
  const entity: EntityRecord = {
    type,
    name,
    content,
    commitSha: commit.sha,
  };
  return { entities: [entity], relationships: [] };
}

/** Deterministic relationships from shared files / type semantics (D-11). */
export function deriveRelationships(
  entities: EntityRecord[],
  commitFilesByEntity: Map<string, string[]>
): RelationshipRecord[] {
  const rels: RelationshipRecord[] = [];
  const byId = new Map<string, EntityRecord>();
  for (const e of entities) byId.set(entityId(e), e);

  // Invert the join. This used to compare every entity against every other entity and, inside that
  // comparison, run `files.some((f) => otherFiles.includes(f))` — an array scan inside a loop inside
  // a loop. A pre-release review measured the cost: 2000 commits took 16.4 s, 8000 was killed after
  // 60 s, which stalls `deepindex git-index` on a real history.
  //
  // The output is unchanged: one row per ordered pair that shares at least one file, labelled from
  // the `from` side. Only the join is inverted and both passes are ordered, so the result stays
  // deterministic instead of depending on map iteration order.
  const entityIdsByFile = new Map<string, string[]>();
  for (const e of entities) {
    const id = entityId(e);
    for (const file of commitFilesByEntity.get(id) ?? []) {
      const bucket = entityIdsByFile.get(file);
      if (bucket) bucket.push(id);
      else entityIdsByFile.set(file, [id]);
    }
  }

  const seen = new Set<string>();
  for (const [file, ids] of [...entityIdsByFile.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    void file;
    const sorted = [...ids].sort();
    for (const from of sorted) {
      const entity = byId.get(from);
      if (!entity) continue;
      for (const to of sorted) {
        if (to === from) continue;
        // A pair that shares several files is still one relationship, as it was.
        const key = `${from}\u0000${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let relationship: RelationshipRecord['relationship'] = 'relates_to';
        if (entity.type === 'bug_fix') relationship = 'fixes';
        else if (entity.type === 'breaking_change') relationship = 'breaks';
        else if (entity.type === 'pattern') relationship = 'implements';
        rels.push({ from, to, relationship, context: 'shared files' });
      }
    }
  }
  return rels;
}

/** UUID5 (RFC-4122) from type:name — node has no built-in. */
export function entityId(entity: { type: string; name: string }): string {
  return uuid5(`type:${entity.type}:${entity.name}`);
}

export function uuid5(input: string): string {
  const hash = createHash('sha1').update(input).digest();
  // Set version (5) and variant (RFC 4122).
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
  const hex = hash.toString('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** LLM batch extraction (optional, D-08/D-09). Sanitizes diffs first (D-14). */
export async function extractLLMBatch(
  batch: CommitRecord[],
  llm: LLMClient
): Promise<ExtractionResult> {
  const prompt = buildBatchPrompt(batch);
  const resp = await llm.complete(prompt);
  const content = stripFences(resp.content);
  let data: { entities?: Array<{ type?: string; name?: string; content?: string }> };
  try {
    data = JSON.parse(content);
  } catch {
    return { entities: [], relationships: [] };
  }
  const entities: EntityRecord[] = [];
  for (const item of data.entities ?? []) {
    const type = item.type as EntityType;
    if (!ENTITY_TYPES.includes(type)) continue;
    const name = (item.name ?? '').toLowerCase().trim();
    if (!name) continue;
    entities.push({
      type,
      name,
      content: item.content ?? '',
      commitSha: batch[0]?.sha ?? '',
    });
  }
  return { entities, relationships: [] };
}

function stripFences(content: string): string {
  let c = content.trim();
  if (c.startsWith('```json')) c = c.slice(7);
  if (c.startsWith('```')) c = c.slice(3);
  if (c.endsWith('```')) c = c.slice(0, -3);
  return c.trim();
}

const DIFF_PER_COMMIT = 800;

export function buildBatchPrompt(batch: CommitRecord[]): string {
  const blocks = batch.map((r) => {
    const diff = sanitizeDiff(r.diff).slice(0, DIFF_PER_COMMIT);
    return `--- Commit ${r.shortSha} by ${r.author} ---\nMessage: ${r.message}\nDiff (sanitized):\n${diff}`;
  });
  return `You are a code knowledge extractor. Return ONLY valid JSON:
{"entities": [{"type": "<decision|bug_fix|pattern|tech_debt|concept|breaking_change|security_fix|workflow>", "name": "<lowercase kebab-case>", "content": "<why and how>", "commit_sha": "<7-char sha>"}]}

Commits to analyze:
${blocks.join('\n\n')}`;
}
