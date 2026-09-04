import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 5;

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS health_signals (
  key TEXT PRIMARY KEY,
  value REAL NOT NULL,
  source TEXT,
  updated_at INTEGER NOT NULL
);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS sql_queries (
  id INTEGER PRIMARY KEY,
  query_text TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS query_tables (
  query_id INTEGER NOT NULL REFERENCES sql_queries(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  PRIMARY KEY (query_id, table_name)
);
CREATE INDEX IF NOT EXISTS idx_query_tables_name ON query_tables(table_name);
CREATE INDEX IF NOT EXISTS idx_sql_queries_file ON sql_queries(file_id);
`;

// Phase 5: Git-History Knowledge Graph (schema v5). Temporal KG tables —
// commits, commit_files (link to existing files), entities, entity_symbols
// (link to existing symbols), backlinks, metadata, entities_fts + triggers.
const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS commits (
  sha TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  author TEXT NOT NULL,
  author_date TEXT NOT NULL,
  committer_date TEXT NOT NULL,
  insertions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  parent_sha TEXT,
  commit_type TEXT NOT NULL DEFAULT 'other'
);
CREATE TABLE IF NOT EXISTS commit_files (
  commit_sha TEXT NOT NULL REFERENCES commits(sha) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  PRIMARY KEY (commit_sha, file_id)
);
CREATE INDEX IF NOT EXISTS idx_commit_files_file ON commit_files(file_id);
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','bug_fix','pattern','tech_debt','concept','breaking_change','security_fix','workflow')),
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  commit_sha TEXT REFERENCES commits(sha),
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
CREATE TABLE IF NOT EXISTS entity_symbols (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  PRIMARY KEY (entity_id, symbol_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_symbols_symbol ON entity_symbols(symbol_id);
CREATE TABLE IF NOT EXISTS backlinks (
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (from_id, to_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_backlinks_to ON backlinks(to_id);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name,
  content,
  content=entities,
  content_rowid=rowid,
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
END;
CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content) VALUES('delete', old.rowid, old.name, old.content);
END;
CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, content) VALUES('delete', old.rowid, old.name, old.content);
  INSERT INTO entities_fts(rowid, name, content) VALUES (new.rowid, new.name, new.content);
END;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  language TEXT,
  parsed_at INTEGER
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  complexity INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id),
  resolved INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  to_symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_symbol_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_symbol_id);
CREATE TABLE IF NOT EXISTS requirement_code_links (
  symbol_id INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
  req_id TEXT NOT NULL,
  PRIMARY KEY (symbol_id, req_id)
);
CREATE INDEX IF NOT EXISTS idx_req_links_req ON requirement_code_links(req_id);
CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  confidence REAL NOT NULL,
  size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cache_last_access ON cache(last_access);
`;

let _db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec(SCHEMA_V2);
  db.exec(SCHEMA_V3);
  db.exec(SCHEMA_V5);
  // Idempotent column migration: `complexity` was added to the base CREATE
  // TABLE, but CREATE TABLE IF NOT EXISTS is a no-op on existing DBs, so a
  // pre-existing .deepindex.db lacks the column. Add it if missing. This is the
  // seed of a versioned migration ladder — extend per-version below as the
  // schema grows.
  const cols = db.pragma('table_info(symbols)') as { name: string }[];
  if (!cols.some((c) => c.name === 'complexity')) {
    db.exec('ALTER TABLE symbols ADD COLUMN complexity INTEGER DEFAULT 0');
  }
  const v = db.pragma('user_version', { simple: true }) as number;
  if (v < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  _db = db;
  return db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('Database not initialized — call initDb() first');
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
