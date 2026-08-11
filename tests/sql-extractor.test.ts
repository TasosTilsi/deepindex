import { describe, it, expect } from 'vitest';
import { extractTables } from '../src/parser/sql-extractor.js';

describe('extractTables', () => {
  it('should extract table name from ORM annotations', () => {
    const code = '@Table(name="orders")\nclass Order {}';
    expect(extractTables(code)).toContain('orders');
  });

  it('should extract collection name from MongoDB syntax', () => {
    const code = 'db.collection("logs").find()';
    expect(extractTables(code)).toContain('logs');
  });

  it('should extract all referenced tables from a complex SELECT with JOINs', () => {
    const sql = 'SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.status = "active"';
    const tables = extractTables(sql);
    expect(tables).toContain('users');
    expect(tables).toContain('orders');
  });

  it('should extract referenced tables from a nested subquery via regex', () => {
    // Regex path walks all FROM/JOIN occurrences, including those inside subqueries.
    const sql = 'SELECT * FROM (SELECT id FROM users WHERE id IN (SELECT user_id FROM logs)) as sub';
    const tables = extractTables(sql);
    expect(tables).toContain('users');
    expect(tables).toContain('logs');
  });

  it('returns a deduplicated, unique list', () => {
    const sql = 'SELECT * FROM users JOIN users u2 ON users.id = u2.id';
    expect(extractTables(sql)).toEqual(['users']);
  });

  it('does not extract table names from comments', () => {
    const code = '// FROM old\nSELECT * FROM users /* FROM legacy */ -- FROM commented';
    const tables = extractTables(code);
    expect(tables).toContain('users');
    expect(tables).not.toContain('old');
    expect(tables).not.toContain('legacy');
    expect(tables).not.toContain('commented');
  });
});