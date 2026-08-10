import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { BuildStats } from './build.js';
import { parseFile } from './parse.js';
import { resolveImport } from './resolve.js';
import { extractSql } from '../parser/sql-extractor.js';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.omc',
  '.planning',
  '.claude',
  '.next',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
]);

const SUPPORTED_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql']);

export async function buildGraph(
  db: Database.Database,
  repoPath: string,
  opts: { force?: boolean } = {}
): Promise<BuildStats> {
  const start = Date.now();
  const absRoot = resolve(repoPath);
  const files = walk(absRoot);

  const insertFile = db.prepare(
    `INSERT INTO files (path, hash, mtime, size, language, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       hash = excluded.hash,
       mtime = excluded.mtime,
       size = excluded.size,
       language = excluded.language,
       parsed_at = excluded.parsed_at`
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertImport = db.prepare(
    `INSERT INTO imports (file_id, source, resolved_file_id, resolved)
     VALUES (?, ?, ?, ?)`
  );
  const getFileByPath = db.prepare('SELECT id FROM files WHERE path = ?');
  const deleteSymbolsForFile = db.prepare(
    'DELETE FROM symbols WHERE file_id = ?'
  );
  const deleteImportsForFile = db.prepare(
    'DELETE FROM imports WHERE file_id = ?'
  );

  let fileCount = 0;
  let symbolCount = 0;
  let brokenImportCount = 0;
  let skippedCount = 0;
  const needsParse: Array<{ relPath: string; fileId: number; content: string; absPath: string; ext: string }> = [];

  // First pass: insert/upsert all file rows so imports can resolve to them.
  for (const file of files) {
    const relPath = relative(absRoot, file.absPath);
    const content = readFileSync(file.absPath, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');

    const existing = db
      .prepare('SELECT hash FROM files WHERE path = ?')
      .get(relPath) as { hash: string } | undefined;

    if (existing && existing.hash === hash && !opts.force) {
      skippedCount++;
      continue;
    }

    const lang = extToLang(file.ext);
    insertFile.run(relPath, hash, file.mtime, file.size, lang, Date.now());
    const row = db
      .prepare('SELECT id FROM files WHERE path = ?')
      .get(relPath) as { id: number } | undefined;
    if (!row) continue;
    needsParse.push({ relPath, fileId: row.id, content, absPath: file.absPath, ext: file.ext });
    fileCount++;
  }

  // Second pass: parse + extract symbols/imports. All file rows exist now.
  for (const { relPath, fileId, content, absPath, ext } of needsParse) {
    deleteSymbolsForFile.run(fileId);
    deleteImportsForFile.run(fileId);

    const { symbols, imports } = await parseFile(absPath, content, ext);
    for (const s of symbols) {
      insertSymbol.run(fileId, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0);
      symbolCount++;
    }

    for (const imp of imports) {
      const resolved = resolveImport(absRoot, relPath, imp.source, files);
      if (resolved) {
        const targetRow = getFileByPath.get(resolved) as { id: number } | undefined;
        if (targetRow) {
          insertImport.run(fileId, imp.source, targetRow.id, 1);
        } else {
          insertImport.run(fileId, imp.source, null, 0);
          brokenImportCount++;
        }
      } else {
        insertImport.run(fileId, imp.source, null, 0);
        brokenImportCount++;
      }
    }

    // SQL Extraction pass
    const { queries } = extractSql(content);
    const insertQuery = db.prepare('INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)');
    const insertQueryTable = db.prepare('INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)');

    for (const q of queries) {
      const info = insertQuery.run(q.text, fileId);
      const queryId = info.lastInsertRowid;
      for (const table of q.tables) {
        insertQueryTable.run(queryId, table);
      }
    }
  }

  // Build edges: for each import that resolved, link source file's first symbol
  // to each exported symbol of target file. Cheap approximation of symbol-level
  // import resolution; enough for BFS.
  buildFileLevelEdges(db);

  return {
    fileCount,
    symbolCount,
    brokenImportCount,
    elapsedMs: Date.now() - start,
  };
}

function buildFileLevelEdges(db: Database.Database): void {
  db.exec('DELETE FROM edges');
  const importRows = db
    .prepare(
      `SELECT i.id, i.file_id, i.resolved_file_id
       FROM imports i
       WHERE i.resolved = 1 AND i.resolved_file_id IS NOT NULL`
    )
    .all() as { id: number; file_id: number; resolved_file_id: number }[];

  const insertEdge = db.prepare(
    `INSERT INTO edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, 'imports')`
  );
  // For each import, find one representative symbol in source file (first exported)
  // and link to all exported symbols in target file. Skip if no exports.
  const getFirstExported = db.prepare(
    `SELECT id FROM symbols WHERE file_id = ? AND exported = 1 ORDER BY id LIMIT 1`
  );
  const getExported = db.prepare(
    `SELECT id FROM symbols WHERE file_id = ? AND exported = 1`
  );

  const tx = db.transaction((rows: typeof importRows) => {
    for (const r of rows) {
      const from = getFirstExported.get(r.file_id) as { id: number } | undefined;
      if (!from) continue;
      const targets = getExported.all(r.resolved_file_id) as { id: number }[];
      for (const t of targets) {
        if (t.id !== from.id) {
          insertEdge.run(from.id, t.id);
        }
      }
    }
  });
  tx(importRows);
}

function walk(
  root: string
): Array<{ absPath: string; ext: string; mtime: number; size: number }> {
  const out: Array<{ absPath: string; ext: string; mtime: number; size: number }> = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        const ext = extname(name);
        if (SUPPORTED_EXTS.has(ext)) {
          out.push({
            absPath: full,
            ext,
            mtime: Math.floor(st.mtimeMs),
            size: st.size,
          });
        }
      }
    }
  }
  return out;
}

function extname(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i);
}

function extToLang(ext: string): string {
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  return 'unknown';
}
