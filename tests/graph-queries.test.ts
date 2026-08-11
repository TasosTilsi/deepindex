import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { projectFullGraph } from '../src/graph/projection.js';
import { getImpact, findParallelStorage } from '../src/graph/sql-impact.js';

describe('Graph Analysis', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, language TEXT, parsed_at INTEGER);
      CREATE TABLE sql_queries (id INTEGER PRIMARY KEY, query_text TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id));
      CREATE TABLE query_tables (query_id INTEGER NOT NULL REFERENCES sql_queries(id), table_name TEXT NOT NULL, PRIMARY KEY (query_id, table_name));
    `);

    // UserService uses SQL
    db.prepare('INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)').run('src/services/UserService.ts', 'h1', 100, 10);
    db.prepare('INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)').run('SELECT * FROM users', 1);
    db.prepare('INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)').run(1, 'users');

    // UserMongoService uses Mongo (simulated by path)
    db.prepare('INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)').run('src/mongo/UserMongoService.ts', 'h2', 100, 10);
    db.prepare('INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)').run('db.users.find()', 2);
    db.prepare('INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)').run(2, 'users');
  });

  it('finds impact for a table', () => {
    const graph = projectFullGraph(db);
    const impact = getImpact(graph, 'users');
    
    expect(impact.tableName).toBe('users');
    expect(impact.affectedQueries.length).toBe(2);
    expect(impact.affectedFiles).toContain('src/services/UserService.ts');
    expect(impact.affectedFiles).toContain('src/mongo/UserMongoService.ts');
    expect(impact.affectedServices).toContain('UserService');
    expect(impact.affectedServices).toContain('UserMongoService');
  });

  it('identifies parallel storage', () => {
    const graph = projectFullGraph(db);
    const parallel = findParallelStorage(graph);
    
    expect(parallel.length).toBe(1);
    expect(parallel[0].tableName).toBe('users');
    expect(parallel[0].systems).toContain('sql');
    expect(parallel[0].systems).toContain('mongodb');
  });
});
