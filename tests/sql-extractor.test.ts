import { describe, it, expect } from 'vitest';
import {
  extractTables,
  splitColumnDefinitions,
  extractTablesFormal,
  extractConfigMappings,
  extractSql,
} from '../src/parser/sql-extractor.js';

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

describe('splitColumnDefinitions', () => {
  it('splits a simple comma-separated column list', () => {
    expect(splitColumnDefinitions('id INT, name VARCHAR(255), active BOOLEAN')).toEqual([
      'id INT',
      'name VARCHAR(255)',
      'active BOOLEAN',
    ]);
  });

  it('respects nested parentheses in column types (Case 1)', () => {
    const cols = 'id INT, meta JSON(10,2), PRIMARY KEY (id)';
    expect(splitColumnDefinitions(cols)).toEqual([
      'id INT',
      'meta JSON(10,2)',
      'PRIMARY KEY (id)',
    ]);
  });

  it('strips an outer paren wrapper if present', () => {
    const cols = '(id INT, meta JSON(10,2))';
    expect(splitColumnDefinitions(cols)).toEqual(['id INT', 'meta JSON(10,2)']);
  });

  it('handles deeply nested parens without splitting inside them', () => {
    const cols = 'a INT, b DECIMAL(10, (2 + 3)), c TEXT';
    expect(splitColumnDefinitions(cols)).toEqual([
      'a INT',
      'b DECIMAL(10, (2 + 3))',
      'c TEXT',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(splitColumnDefinitions('')).toEqual([]);
    expect(splitColumnDefinitions('()')).toEqual([]);
  });
});

describe('extractTables ORM + Mongo extensions', () => {
  it('extracts table name from @Entity annotation', () => {
    const code = '@Entity(name="account")\nclass Account {}';
    expect(extractTables(code)).toContain('account');
  });

  it('extracts collection name from getCollection Mongo syntax', () => {
    const code = 'const c = db.getCollection("audit")';
    expect(extractTables(code)).toContain('audit');
  });

  it('extracts collection from both db.collection and getCollection', () => {
    const code = 'db.collection("logs").find(); db.getCollection("audit").find()';
    const tables = extractTables(code);
    expect(tables).toContain('logs');
    expect(tables).toContain('audit');
  });
});

describe('extractSql (Coordinator — regex + formal union)', () => {
  it('extracts ONLY real tables from a complex SELECT with JOINs (no aliases/columns)', () => {
    // CR-01 regression guard: aliases (u, o) and ON-condition columns (id,
    // user_id) must NOT appear in the merged table set.
    const sql =
      'SELECT u.name, o.amount FROM users u JOIN orders o ON u.id = o.user_id WHERE u.status = "active"';
    const tables = extractSql(sql).queries[0].tables.slice().sort();
    expect(tables).toEqual(['orders', 'users']);
  });

  it('extracts real tables from nested subqueries (no alias/column pollution)', () => {
    const sql =
      'SELECT * FROM (SELECT id FROM users WHERE id IN (SELECT user_id FROM logs)) as sub';
    const tables = extractSql(sql).queries[0].tables.slice().sort();
    expect(tables).toEqual(['logs', 'users']);
  });

  it('returns an empty array for unparseable SQL without throwing', () => {
    expect(extractTablesFormal('not actually sql at all !!')).toEqual([]);
  });

  it('extracts the table name from a CREATE TABLE statement (formal path)', () => {
    const sql = 'CREATE TABLE users (id INT, meta JSON(10,2))';
    expect(extractTablesFormal(sql)).toContain('users');
  });

  it('extracts the table from INSERT/UPDATE/DELETE statements (formal path)', () => {
    expect(extractTablesFormal('INSERT INTO orders (a, b) VALUES (1, 2)').sort()).toEqual(['orders']);
    expect(extractTablesFormal('UPDATE users SET x=1 WHERE id=5').sort()).toEqual(['users']);
    expect(extractTablesFormal('DELETE FROM logs WHERE id=5').sort()).toEqual(['logs']);
  });
});

describe('extractConfigMappings (XML/YAML)', () => {
  it('extracts table names from Hibernate-style XML mappings', () => {
    const xml = '<class name="User" table="users"/>\n<class name="Order" table="orders"/>';
    const tables = extractConfigMappings(xml);
    expect(tables).toContain('users');
    expect(tables).toContain('orders');
  });

  it('extracts table names from YAML entity mappings', () => {
    const yaml = 'User:\n  table: users\nOrder:\n  table: orders\n';
    const tables = extractConfigMappings(yaml);
    expect(tables).toContain('users');
    expect(tables).toContain('orders');
  });

  it('returns empty array for plain code without config mappings', () => {
    expect(extractConfigMappings('const x = 1; // table: foo')).toEqual([]);
  });
});

describe('extractSql coordinator (dual-path)', () => {
  it('returns one SqlQuery per block with merged tables', () => {
    const { queries } = extractSql('SELECT * FROM users JOIN orders ON users.id = orders.uid');
    expect(queries).toHaveLength(1);
    expect(queries[0].tables).toContain('users');
    expect(queries[0].tables).toContain('orders');
  });

  it('falls back to the formal path for tables the regex path misses', () => {
    // Correlated subquery: regex FROM walk picks all three, but formal path should
    // also resolve them. Coordinator merges both paths.
    const sql =
      'SELECT * FROM users WHERE id IN (SELECT user_id FROM logs WHERE evt IN (SELECT name FROM events))';
    const { queries } = extractSql(sql);
    const tables = queries[0].tables;
    expect(tables).toContain('users');
    expect(tables).toContain('logs');
    expect(tables).toContain('events');
  });

  it('does not throw on text that is neither SQL nor ORM', () => {
    const { queries } = extractSql('const greeting = "hello world";');
    expect(queries).toHaveLength(1);
    expect(queries[0].tables).toEqual([]);
  });
});