import { describe, it, expect } from 'vitest';
import {
  classifyType,
  deriveName,
  extractDeterministic,
  deriveRelationships,
  entityId,
  uuid5,
  ENTITY_TYPES,
} from '../src/git/extract.js';
import { sanitizeDiff, shannonEntropy } from '../src/git/sanitize.js';
import type { CommitRecord } from '../src/git/walker.js';

function commit(over: Partial<CommitRecord>): CommitRecord {
  return {
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    author: 'Test',
    authorDate: '2026-01-01T00:00:00Z',
    committerDate: '2026-01-01T00:00:00Z',
    message: '',
    diff: '',
    filesChanged: [],
    insertions: 0,
    deletions: 0,
    parentSha: null,
    ...over,
  };
}

describe('git extract', () => {
  it('has 8 refined entity types (D-15)', () => {
    expect(ENTITY_TYPES).toEqual([
      'decision',
      'bug_fix',
      'pattern',
      'tech_debt',
      'concept',
      'breaking_change',
      'security_fix',
      'workflow',
    ]);
  });

  it('classifyType detects bug_fix', () => {
    expect(classifyType('fix: off-by-one error', [])).toBe('bug_fix');
  });

  it('classifyType detects breaking_change', () => {
    expect(classifyType('refactor: breaking change - add returns bigint', [])).toBe('breaking_change');
  });

  it('classifyType detects security_fix', () => {
    expect(classifyType('security: fix CVE-2024-0001 injection', [])).toBe('security_fix');
  });

  it('classifyType detects decision', () => {
    expect(classifyType('feat: decision to standardize on ESM', [])).toBe('decision');
  });

  it('classifyType falls back to concept', () => {
    expect(classifyType('misc update', [])).toBe('concept');
  });

  it('deriveName strips conventional-commit prefix and kebab-cases', () => {
    expect(deriveName('feat: add mul function')).toBe('add-mul-function');
    expect(deriveName('fix(auth): login bug')).toBe('login-bug');
  });

  it('extractDeterministic returns one typed entity per commit', () => {
    const c = commit({ message: 'fix: off-by-one error in counter loop', filesChanged: ['src/counter.ts'] });
    const r = extractDeterministic(c);
    expect(r.entities).toHaveLength(1);
    expect(r.entities[0].type).toBe('bug_fix');
    expect(r.entities[0].name).toBe('off-by-one-error-in-counter-loop');
    expect(r.entities[0].commitSha).toBe(c.sha);
  });

  it('uuid5 is deterministic and version-5', () => {
    const a = uuid5('type:bug_fix:test');
    const b = uuid5('type:bug_fix:test');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('entityId is stable across calls', () => {
    expect(entityId({ type: 'bug_fix', name: 'x' })).toBe(entityId({ type: 'bug_fix', name: 'x' }));
  });

  it('deriveRelationships creates typed edges from shared files', () => {
    const bug = { type: 'bug_fix' as const, name: 'b', content: '', commitSha: 'x' };
    const brk = { type: 'breaking_change' as const, name: 'c', content: '', commitSha: 'y' };
    const files = new Map<string, string[]>([
      [entityId(bug), ['src/a.ts']],
      [entityId(brk), ['src/a.ts']],
    ]);
    const rels = deriveRelationships([bug, brk], files);
    expect(rels.length).toBeGreaterThan(0);
    expect(rels[0].relationship).toBe('fixes');
  });
});

describe('git sanitize', () => {
  it('shannonEntropy is high for random strings', () => {
    expect(shannonEntropy('abcdefghijklmnopqrstuvwxyz')).toBeGreaterThan(3.5);
    expect(shannonEntropy('aaaaaaa')).toBeLessThan(1);
  });

  it('redacts API keys', () => {
    expect(sanitizeDiff('token=sk-1234567890abcdef')).toContain('[REDACTED:api_key]');
  });

  it('redacts high-entropy tokens', () => {
    expect(sanitizeDiff('value 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')).toContain(
      '[REDACTED:high_entropy]'
    );
  });

  it('leaves normal code unchanged', () => {
    const code = 'export function add(a: number, b: number) { return a + b; }';
    expect(sanitizeDiff(code)).toBe(code);
  });
});
