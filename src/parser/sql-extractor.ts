import type Database from 'better-sqlite3';

export interface SqlExtractionResult {
  queries: Array<{
    text: string;
    tables: string[];
  }>;
}

export function extractSql(content: string): SqlExtractionResult {
  const queries: Array<{ text: string; tables: string[] }> = [];

  // 1. Extract CREATE TABLE
  // Matches: CREATE TABLE [IF NOT EXISTS] \s+ ([a-zA-Z0-9_.]+)
  const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_.]+)/gi;
  let match;
  while ((match = createTableRegex.exec(content)) !== null) {
    const tableName = match[1];
    if (tableName) {
      queries.push({
        text: match[0],
        tables: [tableName]
      });
    }
  }

  // 2. Extract SELECT FROM
  // Matches: SELECT .*? FROM\s+([a-zA-Z0-9_.]+)
  // This is minimal. It looks for the first table after FROM.
  const selectFromRegex = /SELECT\s+.*?\s+FROM\s+([a-zA-Z0-9_.]+)/gi;
  while ((match = selectFromRegex.exec(content)) !== null) {
    const tableName = match[1];
    if (tableName) {
      queries.push({
        text: match[0],
        tables: [tableName]
      });
    }
  }

  return { queries };
}
