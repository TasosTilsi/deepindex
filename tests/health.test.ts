import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import type Database from 'better-sqlite3';

describe('health', () => {
  describe('schema migration', () => {
    it('bumps user_version to 2 and creates health_signals table', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'ctx-schema-'));
      const dbPath = join(tmp, 'test.db');
      const db = initDb(dbPath);
      const v = db.pragma('user_version', { simple: true }) as number;
      expect(v).toBe(2);
      const row = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='health_signals'"
        )
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe('health_signals');
      db.close();
    });
  });
});
