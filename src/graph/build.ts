import type Database from 'better-sqlite3';
import { buildGraph as buildGraphImpl } from './buildImpl.js';

export interface BuildStats {
  fileCount: number;
  symbolCount: number;
  brokenImportCount: number;
  elapsedMs: number;
}

export async function buildGraph(
  db: Database.Database,
  repoPath: string
): Promise<BuildStats> {
  return buildGraphImpl(db, repoPath);
}
