import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { initDb } from '../src/graph/db.js';
import { upsertRequirements } from '../src/requirements/sync.js';
import { htmlToText, normalizeRequirements, mapExternalStatus } from '../src/requirements/sources.js';
import { getEntity } from '../src/mcp/tools.js';
import type Database from 'better-sqlite3';

/**
 * Requirements import v1 (issue #7).
 *
 * The issue asked for a live Jira/GitHub pull. Two of its premises were wrong for this
 * codebase — there is no `last_seen` cursor on `requirements`, and `extractAtomicStatements`
 * does not decompose a rendered HTML description at all — and a networked pull would have
 * brought credential handling, pagination, retries and a CI-untestable surface with it. v1
 * ingests an export file offline through an adapter, and derives the ticket-to-commit link
 * as a query instead of storing it, so it can never go stale.
 *
 * Invariants locked here:
 *   1. adapters map a Jira/GitHub export into the requirement shape, with HTML stripped;
 *   2. the canonical deepindex shape still passes through untouched;
 *   3. upserting is idempotent — no duplicated atomic statements on re-import;
 *   4. `requirements import` reports counts and validates its input;
 *   5. `get_entity("WV-123")` returns the requirement and the commits that cite it, and
 *      `WV-12` does not match `WV-123`.
 */
const JIRA_ISSUE = {
  key: 'WV-123',
  self: 'https://acme.atlassian.net/rest/api/3/issue/10001',
  fields: {
    summary: 'Retry policy',
    description:
      '<p>The system shall retry <b>3</b> times.</p><ul><li>Use exponential backoff</li></ul>',
    status: { name: 'In Progress' },
  },
};

function tmpDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-req-import-'));
  return { db: initDb(join(dir, 'test.db')), dir };
}

function run(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const tsxBin = resolve(process.cwd(), 'node_modules/.bin/tsx');
    const child = spawn(tsxBin, ['src/cli.ts', ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    child.on('error', (err) =>
      resolveRun({ code: -1, stdout, stderr: stderr + '\n' + err.message })
    );
  });
}

describe('requirements adapters', () => {
  it('maps a Jira issue export into the requirement shape with HTML stripped', () => {
    const report = normalizeRequirements('jira', [JIRA_ISSUE]);
    expect(report.warnings).toEqual([]);
    expect(report.skipped).toBe(0);
    expect(report.requirements).toEqual([
      {
        id: 'WV-123',
        title: 'Retry policy',
        description: 'The system shall retry 3 times.\n- Use exponential backoff',
        source: 'https://acme.atlassian.net/rest/api/3/issue/10001',
        status: 'approved',
      },
    ]);
  });

  it('accepts a Jira JQL search response wrapper as well as a bare array', () => {
    expect(normalizeRequirements('jira', { issues: [JIRA_ISSUE] }).requirements).toHaveLength(1);
  });

  it('strips tags and decodes entities so bullet decomposition still works', () => {
    expect(htmlToText('<ul><li>Hash passwords &amp; salt</li></ul>')).toBe('- Hash passwords & salt');
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo');
  });

  it('maps statuses, warning on an unknown one instead of failing', () => {
    expect(mapExternalStatus('Done').status).toBe('implemented');
    expect(mapExternalStatus('Closed').status).toBe('implemented');
    expect(mapExternalStatus('In Progress').status).toBe('approved');
    expect(mapExternalStatus('To Do').status).toBe('draft');
    const unknown = mapExternalStatus('Blocked');
    expect(unknown.status).toBe('draft');
    expect(unknown.warning).toMatch(/Blocked/);
  });

  it('skips pull requests and unlabelled entries in a GitHub export', () => {
    const report = normalizeRequirements('github', [
      { number: 1, title: 'Real', body: 'The system shall work.', html_url: 'u1', state: 'open', labels: [{ name: 'requirement' }] },
      { number: 2, title: 'A PR', body: 'x', html_url: 'u2', state: 'open', labels: [{ name: 'requirement' }], pull_request: {} },
      { number: 3, title: 'Unlabelled', body: 'x', html_url: 'u3', state: 'open', labels: [] },
    ]);
    expect(report.requirements).toHaveLength(1);
    expect(report.requirements[0]).toMatchObject({ id: 'GH-1', source: 'u1', status: 'draft' });
    expect(report.skipped).toBe(2);
  });

  it('passes the canonical deepindex shape through unchanged', () => {
    const canonical = {
      id: 'REQ-1',
      title: 'T',
      description: 'The system shall be deterministic.',
      source: 'docs/DESIGN.md',
      status: 'approved' as const,
    };
    expect(normalizeRequirements('deepindex', [canonical]).requirements).toEqual([canonical]);
  });
});

describe('upsertRequirements', () => {
  it('is idempotent: re-importing leaves one requirement and no duplicated statements', () => {
    const { db, dir } = tmpDb();
    try {
      const [req] = normalizeRequirements('jira', [JIRA_ISSUE]).requirements;
      upsertRequirements(db, [req]);
      upsertRequirements(db, [req]);

      const reqs = db.prepare('SELECT COUNT(*) AS c FROM requirements').get() as { c: number };
      const atomics = db.prepare('SELECT COUNT(*) AS c FROM atomic_requirements').get() as { c: number };
      expect(reqs.c).toBe(1);
      expect(atomics.c).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('requirements import (cli)', () => {
  it('imports a Jira export and reports the counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-req-cli-'));
    try {
      const dbPath = join(dir, 'r.db');
      initDb(dbPath).close();
      const file = join(dir, 'jira.json');
      writeFileSync(file, JSON.stringify([JIRA_ISSUE]));

      const r = await run(['requirements', 'import', file, '--format', 'jira', '--db', dbPath]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Imported 1 requirements \(2 atomic statements\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes nothing with --dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-req-cli-'));
    try {
      const dbPath = join(dir, 'r.db');
      const db = initDb(dbPath);
      db.close();
      const file = join(dir, 'jira.json');
      writeFileSync(file, JSON.stringify([JIRA_ISSUE]));

      const r = await run(['requirements', 'import', file, '--format', 'jira', '--dry-run', '--db', dbPath]);
      expect(r.code).toBe(0);
      const check = initDb(dbPath);
      const count = check.prepare('SELECT COUNT(*) AS c FROM requirements').get() as { c: number };
      check.close();
      expect(count.c).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects bad input with exit 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepindex-req-cli-'));
    try {
      const dbPath = join(dir, 'r.db');
      initDb(dbPath).close();
      const file = join(dir, 'jira.json');
      writeFileSync(file, JSON.stringify([JIRA_ISSUE]));

      for (const args of [
        ['requirements', 'import', file, '--format', 'nope', '--db', dbPath],
        ['requirements', 'import', join(dir, 'missing.json'), '--format', 'jira', '--db', dbPath],
        // --format matters here: the default is the canonical deepindex shape, so a Jira
        // payload without it fails schema validation (exit 1) rather than reaching the DB.
        ['requirements', 'import', file, '--format', 'jira', '--db', join(dir, 'absent.db')],
      ]) {
        const r = await run(args);
        expect(r.code, `expected exit 2 for: ${args.join(' ')}`).toBe(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('get_entity: requirement fallback', () => {
  function seed(db: Database.Database): void {
    upsertRequirements(db, normalizeRequirements('jira', [JIRA_ISSUE]).requirements);
    db.prepare(
      "INSERT INTO commits (sha, message, author, author_date, committer_date) VALUES ('a1', 'fix: WV-123 correct retry backoff', 't', '2026-01-01', '2026-01-01')"
    ).run();
    db.prepare(
      "INSERT INTO commits (sha, message, author, author_date, committer_date) VALUES ('b2', 'chore: WV-12 unrelated tidy-up', 't', '2026-01-02', '2026-01-02')"
    ).run();
    db.prepare(
      "INSERT INTO entities (id, type, name, content, commit_sha) VALUES ('e1', 'bug_fix', 'retry-backoff', 'fixes the retry backoff', 'a1')"
    ).run();
    db.prepare(
      "INSERT INTO entities (id, type, name, content, commit_sha) VALUES ('e2', 'workflow', 'tidy-up', 'unrelated', 'b2')"
    ).run();
  }

  it('returns the requirement with its atomic statements and the commits citing it', () => {
    const { db, dir } = tmpDb();
    try {
      seed(db);
      const result = getEntity(db, { entity_id: 'WV-123' }) as Record<string, unknown>;
      // The same discriminator the entity path uses, so a consumer can branch on one field.
      expect(result.type).toBe('requirement');
      expect(result.name).toBe('WV-123');
      expect(result.id).toBe('WV-123');
      expect(result.title).toBe('Retry policy');
      expect((result.statements as unknown[]).length).toBe(2);
      const entities = result.entities as { name: string }[];
      expect(entities.map((e) => e.name)).toContain('retry-backoff');
      expect(entities.map((e) => e.name)).not.toContain('tidy-up');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let WV-12 match WV-123', () => {
    const { db, dir } = tmpDb();
    try {
      seed(db);
      const result = getEntity(db, { entity_id: 'WV-12' }) as Record<string, unknown>;
      // WV-12 is not a requirement here, so the entity path answers instead: not found.
      expect(result.error).toBe('entity not found');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still resolves a plain entity by name', () => {
    const { db, dir } = tmpDb();
    try {
      seed(db);
      const result = getEntity(db, { entity_id: 'retry-backoff' }) as Record<string, unknown>;
      expect(result.name).toBe('retry-backoff');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
