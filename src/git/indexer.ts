// Phase 5: Indexer — full rebuild + incremental sync. UUID5 accumulate (D-10),
// commit_files join (D-16), entity_symbols linkage (D-17), backlinks (D-11),
// last_indexed_sha cursor (D-13).

import type Database from 'better-sqlite3';
import { walkCommits, type CommitRecord } from './walker.js';
import {
  extractDeterministic,
  deriveRelationships,
  entityId,
  type EntityRecord,
  type RelationshipRecord,
} from './extract.js';

const LAST_SHA_KEY = 'last_indexed_sha';

export interface IndexResult {
  commitsProcessed: number;
  entitiesInserted: number;
  entitiesUpdated: number;
  relationshipsWritten: number;
}

/** Derive commit_type from conventional-commit prefix (D-16). */
export function deriveCommitType(message: string): string {
  const m = message.match(/^([a-z]+)(\([^)]*\))?:/i);
  if (!m) return 'other';
  const t = m[1]!.toLowerCase();
  const known = ['feat', 'fix', 'refactor', 'docs', 'chore', 'perf', 'security', 'test', 'build', 'ci', 'style', 'revert'];
  return known.includes(t) ? t : 'other';
}

/** Insert/accumulate a commit row + commit_files links. */
function upsertCommit(db: Database.Database, c: CommitRecord): void {
  db.prepare(
    `INSERT INTO commits (sha, message, author, author_date, committer_date, insertions, deletions, parent_sha, commit_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sha) DO UPDATE SET
       message=excluded.message, author=excluded.author, author_date=excluded.author_date,
       committer_date=excluded.committer_date, insertions=excluded.insertions,
       deletions=excluded.deletions, parent_sha=excluded.parent_sha, commit_type=excluded.commit_type`
  ).run(
    c.sha,
    c.message,
    c.author,
    c.authorDate,
    c.committerDate,
    c.insertions,
    c.deletions,
    c.parentSha,
    deriveCommitType(c.message)
  );
  const ins = db.prepare(
    `INSERT OR IGNORE INTO commit_files (commit_sha, file_id)
     SELECT ?, id FROM files WHERE path = ?`
  );
  for (const path of c.filesChanged) {
    ins.run(c.sha, path);
  }
}

/** Accumulate an entity: insert if new, append content + bump last_seen if exists (D-10). */
function upsertEntity(db: Database.Database, e: EntityRecord): { inserted: boolean } {
  const id = entityId(e);
  const existing = db.prepare('SELECT content FROM entities WHERE id = ?').get(id) as
    | { content: string }
    | undefined;
  if (existing) {
    const merged = existing.content.includes(e.content) ? existing.content : `${existing.content}\n${e.content}`;
    db.prepare(
      `UPDATE entities SET content = ?, last_seen = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`
    ).run(merged, id);
    return { inserted: false };
  }
  db.prepare(
    `INSERT INTO entities (id, type, name, content, commit_sha) VALUES (?, ?, ?, ?, ?)`
  ).run(id, e.type, e.name, e.content, e.commitSha);
  return { inserted: true };
}

/** Link an entity to symbols by name match in the commit's files (D-17). */
function linkEntitySymbols(db: Database.Database, e: EntityRecord, files: string[]): void {
  if (files.length === 0) return;
  const id = entityId(e);
  const placeholders = files.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id FROM symbols s JOIN files f ON s.file_id = f.id
       WHERE f.path IN (${placeholders}) AND LOWER(s.name) = LOWER(?)`
    )
    .all(...files, e.name) as { id: number }[];
  const ins = db.prepare('INSERT OR IGNORE INTO entity_symbols (entity_id, symbol_id) VALUES (?, ?)');
  for (const r of rows) ins.run(id, r.id);
}

function writeBacklinks(db: Database.Database, rels: RelationshipRecord[]): void {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO backlinks (from_id, to_id, relationship, context) VALUES (?, ?, ?, ?)`
  );
  for (const r of rels) {
    ins.run(r.from, r.to, r.relationship, r.context);
    // Bidirectional (D-11): write inverse edge too.
    ins.run(r.to, r.from, `inverse:${r.relationship}`, r.context);
  }
}

function readLastSha(db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(LAST_SHA_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeLastSha(db: Database.Database, sha: string): void {
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(LAST_SHA_KEY, sha);
}

/** Commits after a given sha (oldest-first list). Falls back to all if sha not found. */
function commitsAfter(commits: CommitRecord[], sha: string | null): CommitRecord[] {
  if (!sha) return commits;
  for (let i = 0; i < commits.length; i++) {
    if (commits[i]!.sha === sha) return commits.slice(i + 1);
  }
  return commits; // history rewrite — reindex everything
}

function processCommits(
  db: Database.Database,
  commits: CommitRecord[]
): { inserted: number; updated: number; relationships: number } {
  let inserted = 0;
  let updated = 0;
  const allEntities: EntityRecord[] = [];
  const commitFilesByEntity = new Map<string, string[]>();

  for (const c of commits) {
    upsertCommit(db, c);
    const result = extractDeterministic(c);
    for (const e of result.entities) {
      const r = upsertEntity(db, e);
      if (r.inserted) inserted++;
      else updated++;
      linkEntitySymbols(db, e, c.filesChanged);
      allEntities.push(e);
      commitFilesByEntity.set(entityId(e), c.filesChanged);
    }
  }
  const rels = deriveRelationships(allEntities, commitFilesByEntity);
  writeBacklinks(db, rels);
  return { inserted, updated, relationships: rels.length * 2 };
}

/** Full rebuild: walk all commits, extract, index. */
export function gitIndex(db: Database.Database, repoRoot: string): IndexResult {
  const commits = walkCommits(repoRoot);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM metadata WHERE key = ?').run(LAST_SHA_KEY);
    const r = processCommits(db, commits);
    if (commits.length > 0) writeLastSha(db, commits[commits.length - 1]!.sha);
    return r;
  });
  const r = tx();
  return {
    commitsProcessed: commits.length,
    entitiesInserted: r.inserted,
    entitiesUpdated: r.updated,
    relationshipsWritten: r.relationships,
  };
}

/** Incremental sync: only commits since last_indexed_sha; auto-init if no DB. */
export function gitSync(db: Database.Database, repoRoot: string): IndexResult {
  const lastSha = readLastSha(db);
  const all = walkCommits(repoRoot);
  const newCommits = commitsAfter(all, lastSha);
  if (newCommits.length === 0) {
    return { commitsProcessed: 0, entitiesInserted: 0, entitiesUpdated: 0, relationshipsWritten: 0 };
  }
  const tx = db.transaction(() => {
    const r = processCommits(db, newCommits);
    writeLastSha(db, newCommits[newCommits.length - 1]!.sha);
    return r;
  });
  const r = tx();
  return {
    commitsProcessed: newCommits.length,
    entitiesInserted: r.inserted,
    entitiesUpdated: r.updated,
    relationshipsWritten: r.relationships,
  };
}
