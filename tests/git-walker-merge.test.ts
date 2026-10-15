import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkCommits, fetchDiff, fetchFilesChanged } from '../src/git/walker.js';
import { gitIndex } from '../src/git/indexer.js';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { createGitFixture } from './helpers/git-fixture.js';

/**
 * Merge commits (issue #3).
 *
 * The walker read all parents (`%P`, space-separated) and skipped merges by the
 * *subject* (`Merge `). A merge whose subject does not start with that — routine, since
 * `git merge -m "..."` is common — survived the guard and its `"<p1> <p2>"` string went
 * to git as a single argv element, so `git diff` failed with
 * `fatal: ambiguous argument '<p1> <p2>'`. The process still exited 0 and the failure
 * was visible only on stderr, while that commit's `commit_files`, `entity_symbols` and
 * backlinks were silently lost.
 *
 * Invariants locked here:
 *   1. a multi-parent commit never carries a space-containing parentSha;
 *   2. it is diffed against its FIRST parent, so diff and file list are populated;
 *   3. git's own default-subject merges are still skipped;
 *   4. the indexed commit still gets its commit_files rows.
 */
const MERGE_SUBJECT = 'merge: integrate feature branch';

describe('git walker: merge commits', () => {
  let FIXTURE: string;

  beforeAll(() => {
    FIXTURE = createGitFixture({ withMerge: true });
  });

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });

  it('never emits a space-containing parentSha', () => {
    for (const c of walkCommits(FIXTURE)) {
      expect(c.parentSha ?? '').not.toContain(' ');
    }
  });

  it('diffs a lowercase-subject merge against its first parent', () => {
    const merge = walkCommits(FIXTURE).find((c) => c.message === MERGE_SUBJECT);
    expect(merge).toBeDefined();
    expect(merge!.parentSha).toMatch(/^[0-9a-f]{40}$/);

    const diff = fetchDiff(FIXTURE, merge!.sha, merge!.parentSha);
    expect(diff.length).toBeGreaterThan(0);

    const files = fetchFilesChanged(FIXTURE, merge!.sha, merge!.parentSha);
    expect(files.length).toBeGreaterThan(0);
  });

  it('still skips git default-subject merges', () => {
    const subjects = execFileSync('git', ['log', '--format=%s'], {
      cwd: FIXTURE,
      encoding: 'utf8',
    });
    // Non-vacuous: the fixture really contains a default-subject merge, so the
    // assertion below has something to exclude.
    expect(subjects).toContain('Merge ');
    for (const c of walkCommits(FIXTURE)) {
      expect(c.message.startsWith('Merge ')).toBe(false);
    }
  });

  it('gives the merge commit its commit_files rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-merge-index-'));
    const db = initDb(join(dir, 'test.db'));
    try {
      await buildGraph(db, FIXTURE);
      gitIndex(db, FIXTURE);
      const merge = walkCommits(FIXTURE).find((c) => c.message === MERGE_SUBJECT)!;

      const commit = db
        .prepare('SELECT parent_sha FROM commits WHERE sha = ?')
        .get(merge.sha) as { parent_sha: string } | undefined;
      expect(commit?.parent_sha).toMatch(/^[0-9a-f]{40}$/);

      const files = db
        .prepare('SELECT COUNT(*) AS c FROM commit_files WHERE commit_sha = ?')
        .get(merge.sha) as { c: number };
      expect(files.c).toBeGreaterThan(0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
