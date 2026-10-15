import type Database from 'better-sqlite3';
import { REQUIREMENTS_DDL } from '../graph/db.js';

/**
 * The requirements tables are part of the shared schema as of V7 (issue #15), so this is
 * now a no-op on a database that initDb has opened. It stays because the requirements
 * verbs call it and because a pre-V7 database still needs the DDL applied.
 */
export function initRequirementsDb(db: Database.Database) {
  db.exec(REQUIREMENTS_DDL);
}
