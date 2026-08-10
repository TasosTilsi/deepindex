import type Database from 'better-sqlite3';

export function initRequirementsDb(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requirements (
      id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      source TEXT,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS atomic_requirements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      req_id TEXT,
      statement TEXT,
      type TEXT,
      "order" INTEGER,
      FOREIGN KEY(req_id) REFERENCES requirements(id)
    );
  `);
}
