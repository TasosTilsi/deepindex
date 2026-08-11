import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { projectFullGraph } from '../src/graph/projection.js';

describe('Graph Projection', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, language TEXT, parsed_at INTEGER);
      CREATE TABLE sql_queries (id INTEGER PRIMARY KEY, query_text TEXT NOT NULL, file_id INTEGER NOT NULL REFERENCES files(id));
      CREATE TABLE query_tables (query_id INTEGER NOT NULL REFERENCES sql_queries(id), table_name TEXT NOT NULL, PRIMARY KEY (query_id, table_name));
    `);

    db.prepare('INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)').run('src/services/UserService.ts', 'h1', 100, 10);
    db.prepare('INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?)').run('src/repositories/UserRepository.ts', 'h2', 100, 10);
    db.prepare('INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)').run('SELECT * FROM users', 1);
    db.prepare('INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)').run('UPDATE users SET x=1', 2);
    db.prepare('INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)').run(1, 'users');
    db.prepare('INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)').run(2, 'users');
  });

  it('projects full chain from table to service', () => {
    const graph = projectFullGraph(db);
    
    // Table -> Queries
    const userQueries = graph.tables.get('users');
    expect(userQueries).toBeDefined();
    expect(userQueries?.has(1)).toBe(true);
    expect(userQueries?.has(2)).toBe(true);

    // Query -> File
    const file1 = graph.queries.get(1);
    expect(file1).toBe('src/services/UserService.ts');
    
    // File -> Service
    const service = graph.files.get('src/services/UserService.ts');
    expect(service).toBe('UserService');
  });
});
