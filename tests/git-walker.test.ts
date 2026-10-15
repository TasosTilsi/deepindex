import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { walkCommits, fetchDiff, fetchFilesChanged, batchCommits } from '../src/git/walker.js';
import { createGitFixture } from './helpers/git-fixture.js';

describe('git walker', () => {
  let FIXTURE: string;

  beforeAll(() => {
    FIXTURE = createGitFixture();
  });

  afterAll(() => {
    rmSync(FIXTURE, { recursive: true, force: true });
  });
  it('walks commits oldest-first', () => {
    const commits = walkCommits(FIXTURE);
    expect(commits.length).toBeGreaterThanOrEqual(4);
    // Oldest-first: first commit is the scaffold.
    expect(commits[0].message).toContain('initial project scaffold');
    // Last commit is the most recent.
    expect(commits[commits.length - 1].message).toContain('div');
  });

  // The merge-commit behaviour lives in tests/git-walker-merge.test.ts. The version that
  // used to sit here asserted over a fixture that contains no merges at all, so it could
  // never fail (issue #3); the replacement builds one and checks both directions.

  it('fetches a diff and file list for the root commit, which has no parent', () => {
    const root = walkCommits(FIXTURE)[0];
    expect(root.parentSha).toBeNull();
    expect(fetchDiff(FIXTURE, root.sha, root.parentSha).length).toBeGreaterThan(0);
    expect(fetchFilesChanged(FIXTURE, root.sha, root.parentSha)).toContain('src/version.ts');
  });

  it('populates commit metadata', () => {
    const commits = walkCommits(FIXTURE);
    const c = commits[0];
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.shortSha).toHaveLength(7);
    expect(c.author).toBeTruthy();
    expect(c.authorDate).toBeTruthy();
    expect(c.message).toBeTruthy();
  });

  it('fetchDiff returns a diff for a non-initial commit', () => {
    const commits = walkCommits(FIXTURE);
    const nonInitial = commits.find((c) => c.parentSha);
    expect(nonInitial).toBeDefined();
    const diff = fetchDiff(FIXTURE, nonInitial!.sha, nonInitial!.parentSha);
    expect(diff.length).toBeGreaterThan(0);
  });

  it('fetchDiff caps at 4000 chars', () => {
    const commits = walkCommits(FIXTURE);
    const nonInitial = commits.find((c) => c.parentSha);
    const diff = fetchDiff(FIXTURE, nonInitial!.sha, nonInitial!.parentSha);
    expect(diff.length).toBeLessThanOrEqual(4000);
  });

  it('fetchFilesChanged returns changed paths', () => {
    const commits = walkCommits(FIXTURE);
    const c = commits.find((x) => x.message.includes('div'));
    expect(c).toBeDefined();
    expect(c!.filesChanged).toContain('src/div.ts');
  });

  it('batchCommits splits into batches of 10', () => {
    const commits = walkCommits(FIXTURE);
    const batches = batchCommits(commits, 10);
    expect(batches.length).toBe(1);
    expect(batches[0].length).toBe(commits.length);
    expect(batchCommits([], 10)).toEqual([]);
  });
});
