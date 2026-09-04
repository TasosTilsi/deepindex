// Phase 5: Git walker — traverse git history via child_process (no GitPython).
// Ports Recall's git_walker.py: oldest-first, skip merges, diff cap 4000.

import { execFileSync } from 'node:child_process';

export const DIFF_MAX_CHARS = 4000;

export interface CommitRecord {
  sha: string;
  shortSha: string;
  author: string;
  authorDate: string;
  committerDate: string;
  message: string;
  diff: string;
  filesChanged: string[];
  insertions: number;
  deletions: number;
  parentSha: string | null;
}

/** Run a git command against repoRoot, returning trimmed stdout or '' on error. */
function git(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

/** Parse `git log` porcelain output into raw commit fields. */
function parseLog(raw: string): Array<{
  sha: string;
  author: string;
  authorDate: string;
  committerDate: string;
  message: string;
  parentSha: string | null;
}> {
  if (!raw) return [];
  const out: Array<{
    sha: string;
    author: string;
    authorDate: string;
    committerDate: string;
    message: string;
    parentSha: string | null;
  }> = [];
  // Records separated by \x1e (record separator); fields by \x1f (unit separator).
  // git appends a newline after each record, so trim each record before splitting.
  for (const recRaw of raw.split('\x1e')) {
    const rec = recRaw.trim();
    if (!rec) continue;
    const [sha, author, authorDate, committerDate, parentSha, message] = rec.split('\x1f');
    if (!sha) continue;
    out.push({
      sha,
      author: author ?? '',
      authorDate: authorDate ?? '',
      committerDate: committerDate ?? '',
      parentSha: parentSha || null,
      message: (message ?? '').trim(),
    });
  }
  return out;
}

/** Walk all non-merge commits oldest-first. */
export function walkCommits(repoRoot: string): CommitRecord[] {
  const raw = git(repoRoot, [
    'log',
    '--reverse',
    '--format=%H%x1f%an%x1f%aI%x1f%cI%x1f%P%x1f%s%x1e',
    'HEAD',
  ]);
  const commits = parseLog(raw);
  const records: CommitRecord[] = [];
  for (const c of commits) {
    if (c.message.startsWith('Merge ')) continue;
    records.push({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      author: c.author,
      authorDate: c.authorDate,
      committerDate: c.committerDate,
      message: c.message,
      diff: fetchDiff(repoRoot, c.sha, c.parentSha),
      filesChanged: fetchFilesChanged(repoRoot, c.sha, c.parentSha),
      insertions: 0,
      deletions: 0,
      parentSha: c.parentSha,
    });
  }
  return records;
}

/** Diff vs first parent, truncated to DIFF_MAX_CHARS; initial commit uses --stat. */
export function fetchDiff(repoRoot: string, sha: string, parentSha: string | null): string {
  let diff: string;
  if (parentSha) {
    diff = git(repoRoot, ['diff', parentSha, sha]);
  } else {
    diff = git(repoRoot, ['show', '--stat', sha]);
  }
  return diff.slice(0, DIFF_MAX_CHARS);
}

/** Changed file paths for a commit (via --name-only). */
export function fetchFilesChanged(repoRoot: string, sha: string, parentSha: string | null): string[] {
  const raw = parentSha
    ? git(repoRoot, ['diff', '--name-only', parentSha, sha])
    : git(repoRoot, ['show', '--name-only', '--format=', sha]);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

/** Batch commits for LLM extraction (default 10). */
export function batchCommits(commits: CommitRecord[], batchSize = 10): CommitRecord[][] {
  if (commits.length === 0) return [];
  const out: CommitRecord[][] = [];
  for (let i = 0; i < commits.length; i += batchSize) {
    out.push(commits.slice(i, i + batchSize));
  }
  return out;
}
