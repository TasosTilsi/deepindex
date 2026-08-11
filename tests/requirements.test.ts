import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import { initRequirementsDb } from '../src/requirements/setup.js';
import { extractAtomicStatements } from '../src/requirements/extractor.js';
import { syncRequirements } from '../src/requirements/sync.js';
import { calculateReqCoverage } from '../src/requirements/coverage.js';

describe('requirements', () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-req-'));
    db = initDb(join(dir, 'test.db'));
    initRequirementsDb(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('extractAtomicStatements', () => {
    it('classifies bullet, modal, and general lines', () => {
      const { statements } = extractAtomicStatements(
        'The system shall authenticate users\n- Store passwords hashed\n• Log attempts\nplain intro line'
      );
      expect(statements).toHaveLength(4);
      expect(statements[0]).toEqual({ text: 'The system shall authenticate users', type: 'modal' });
      expect(statements[1]).toEqual({ text: 'Store passwords hashed', type: 'bullet' });
      expect(statements[2]).toEqual({ text: 'Log attempts', type: 'bullet' });
      expect(statements[3]).toEqual({ text: 'plain intro line', type: 'general' });
    });

    it('returns empty for blank input', () => {
      expect(extractAtomicStatements('   \n\n  ').statements).toEqual([]);
    });
  });

  describe('syncRequirements', () => {
    it('imports requirements and splits atomic statements, idempotent on re-run', () => {
      const jsonPath = join(dir, 'reqs.json');
      writeFileSync(
        jsonPath,
        JSON.stringify([
          {
            id: 'REQ-1',
            title: 'Auth',
            description: 'The system must verify credentials\n- Hash passwords',
            source: 'spec.md',
            status: 'approved',
          },
        ])
      );

      const first = syncRequirements(db, jsonPath);
      expect(first.imported).toBe(1);
      expect(first.atomic).toBe(2);

      const row = db
        .prepare('SELECT id, title, status FROM requirements WHERE id = ?')
        .get('REQ-1') as { id: string; title: string; status: string };
      expect(row).toEqual({ id: 'REQ-1', title: 'Auth', status: 'approved' });

      const atomics = db
        .prepare('SELECT statement, type FROM atomic_requirements WHERE req_id = ? ORDER BY "order"')
        .all('REQ-1') as { statement: string; type: string }[];
      expect(atomics).toHaveLength(2);
      expect(atomics[0].type).toBe('modal');
      expect(atomics[1].type).toBe('bullet');

      // Re-run replaces atomics (no duplication) and upserts the requirement.
      const second = syncRequirements(db, jsonPath);
      expect(second.imported).toBe(1);
      expect(second.atomic).toBe(2);
      const count = db
        .prepare('SELECT COUNT(*) AS n FROM atomic_requirements WHERE req_id = ?')
        .get('REQ-1') as { n: number };
      expect(count.n).toBe(2);
    });

    it('accepts a single requirement object (not wrapped in array)', () => {
      const jsonPath = join(dir, 'single.json');
      writeFileSync(
        jsonPath,
        JSON.stringify({
          id: 'REQ-2',
          title: 'T',
          description: 'must do X',
          source: 's',
          status: 'draft',
        })
      );
      const r = syncRequirements(db, jsonPath);
      expect(r.imported).toBe(1);
      expect(r.atomic).toBe(1);
    });

    it('throws on a requirement missing a required field (zod validation)', () => {
      const jsonPath = join(dir, 'bad.json');
      writeFileSync(jsonPath, JSON.stringify([{ id: 'REQ-3', title: 'T' }]));
      expect(() => syncRequirements(db, jsonPath)).toThrow();
    });
  });

  describe('calculateReqCoverage', () => {
    it('reports all requirements as orphans when no @req annotations link code', () => {
      const jsonPath = join(dir, 'reqs.json');
      writeFileSync(
        jsonPath,
        JSON.stringify([
          { id: 'R1', title: 'one', description: 'must', source: 's', status: 'draft' },
          { id: 'R2', title: 'two', description: 'shall', source: 's', status: 'draft' },
        ])
      );
      syncRequirements(db, jsonPath);
      const r = calculateReqCoverage(db);
      expect(r.orphanRequirements).toHaveLength(2);
      expect(r.orphanRequirements.map((o) => o.id)).toEqual(['R1', 'R2']);
    });

    it('reports untracked symbols when no @req annotation covers them', () => {
      // Seed a file + symbol into the graph schema.
      const f = db
        .prepare('INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)')
        .run('src/a.ts', 'h', 1, 10);
      db.prepare(
        'INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, complexity) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(f.lastInsertRowid, 'doThing', 'method', 0, 0, 0, 0);

      const r = calculateReqCoverage(db);
      expect(r.untrackedCode).toContainEqual({ filePath: 'src/a.ts', symbol: 'doThing' });
    });

    it('returns empty orphan list when no requirements exist', () => {
      const r = calculateReqCoverage(db);
      expect(r.orphanRequirements).toEqual([]);
      expect(r.untrackedCode).toEqual([]);
    });

    it('links @req annotations to symbols during build (SC5 traceability)', async () => {
      // Source file: AnnotatedService carries `@req R1`; PlainService has none.
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'svc.ts'),
        [
          '// @req R1',
          'export class AnnotatedService { doThing() {} }',
          '',
          'export class PlainService { doOther() {} }',
        ].join('\n'),
      );
      // Build the graph — the walker extracts @req and inserts links.
      await buildGraph(db, dir);

      // Sync requirements R1 (covered) + R2 (orphan).
      const jsonPath = join(dir, 'reqs.json');
      writeFileSync(
        jsonPath,
        JSON.stringify([
          { id: 'R1', title: 'one', description: 'must', source: 's', status: 'draft' },
          { id: 'R2', title: 'two', description: 'shall', source: 's', status: 'draft' },
        ]),
      );
      syncRequirements(db, jsonPath);

      const r = calculateReqCoverage(db);
      // R1 has a code link -> not orphan; R2 has none -> orphan.
      expect(r.orphanRequirements.map((o) => o.id)).toEqual(['R2']);
      // AnnotatedService is linked -> not untracked; PlainService is not.
      expect(r.untrackedCode.some((u) => u.symbol === 'AnnotatedService')).toBe(false);
      expect(r.untrackedCode.some((u) => u.symbol === 'PlainService')).toBe(true);
    });
  });

  describe('initRequirementsDb', () => {
    it('is idempotent (re-running does not error)', () => {
      expect(() => initRequirementsDb(db)).not.toThrow();
    });
  });
});