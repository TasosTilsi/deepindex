import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseFile } from './parse.js';
import { resolveImport } from './resolve.js';
import { extractSql } from '../parser/sql-extractor.js';
import { EXT_TO_LANG, langForExt } from '../parser/languages.js';

export interface BuildStats {
  fileCount: number;
  symbolCount: number;
  brokenImportCount: number;
  elapsedMs: number;
}

export interface BuildOptions {
  force?: boolean;
}

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

// Supported extensions = every tree-sitter language (single source:
// EXT_TO_LANG from languages.ts) + '.sql' (handled by extractSql, not a
// tree-sitter grammar). Adding a language to LANGUAGE_CONFIGS auto-wires
// it here — no second list to drift.
const SUPPORTED_EXTS = new Set<string>([...EXT_TO_LANG.keys(), '.sql']);

export async function buildGraph(
  db: Database.Database,
  repoPath: string,
  opts: BuildOptions = {}
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
    `INSERT INTO symbols (file_id, name, kind, start_line, end_line, exported, complexity)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertImport = db.prepare(
    `INSERT INTO imports (file_id, source, resolved_file_id, resolved)
     VALUES (?, ?, ?, ?)`
  );
  const getFileByPath = db.prepare('SELECT id FROM files WHERE path = ?');
  const getFileHash = db.prepare('SELECT hash FROM files WHERE path = ?');
  const deleteSymbolsForFile = db.prepare(
    'DELETE FROM symbols WHERE file_id = ?'
  );
  const deleteImportsForFile = db.prepare(
    'DELETE FROM imports WHERE file_id = ?'
  );
  const deleteQueriesForFile = db.prepare(
    'DELETE FROM sql_queries WHERE file_id = ?'
  );
  const insertQuery = db.prepare(
    'INSERT INTO sql_queries (query_text, file_id) VALUES (?, ?)'
  );
  const insertQueryTable = db.prepare(
    'INSERT INTO query_tables (query_id, table_name) VALUES (?, ?)'
  );
  // requirement_code_links: INSERT OR IGNORE — PK (symbol_id, req_id) dedups
  // across re-extraction; re-parse deletes symbols (CASCADE clears links)
  // then re-inserts, so rebuilds stay idempotent.
  const insertReqLink = db.prepare(
    'INSERT OR IGNORE INTO requirement_code_links (symbol_id, req_id) VALUES (?, ?)'
  );

  let fileCount = 0;
  let symbolCount = 0;
  let brokenImportCount = 0;
  const needsParse: Array<{ relPath: string; fileId: number; content: string; absPath: string; ext: string }> = [];

  // First pass: insert/upsert all file rows so imports can resolve to them.
  for (const file of files) {
    const relPath = relative(absRoot, file.absPath);
    const content = readFileSync(file.absPath, 'utf8');
    const hash = createHash('sha256').update(content).digest('hex');

    const existing = getFileHash.get(relPath) as { hash: string } | undefined;

    if (existing && existing.hash === hash && !opts.force) {
      continue;
    }

    const lang = extToLang(file.ext);
    insertFile.run(relPath, hash, file.mtime, file.size, lang, Date.now());
    const row = getFileByPath.get(relPath) as { id: number } | undefined;
    if (!row) continue;
    needsParse.push({ relPath, fileId: row.id, content, absPath: file.absPath, ext: file.ext });
    fileCount++;
  }

  // Second pass: parse + extract symbols/imports. All file rows exist now.
  for (const { relPath, fileId, content, absPath, ext } of needsParse) {
    deleteSymbolsForFile.run(fileId);
    deleteImportsForFile.run(fileId);
    // CASCADE only fires when the file row is removed, not on re-parse, so
    // stale sql_queries/query_tables rows would accumulate across rebuilds.
    deleteQueriesForFile.run(fileId);

    const { symbols, imports } = await parseFile(absPath, content, ext);
    // Capture inserted symbol ids so @req annotations can link to them.
    const insertedSymbols: { id: number; startLine: number }[] = [];
    for (const s of symbols) {
      const info = insertSymbol.run(
        fileId, s.name, s.kind, s.startLine, s.endLine, s.exported ? 1 : 0, s.complexity,
      );
      insertedSymbols.push({ id: Number(info.lastInsertRowid), startLine: s.startLine });
      symbolCount++;
    }

    // Link `@req REQ-XX` annotations to the nearest following symbol
    // (the declaration the comment/JSDoc precedes). Annotations with no
    // following symbol are skipped — links are symbol-level only.
    if (insertedSymbols.length > 0) {
      const sorted = [...insertedSymbols].sort((a, b) => a.startLine - b.startLine);
      for (const ann of extractReqAnnotations(content)) {
        const sym = sorted.find((s) => s.startLine >= ann.line);
        if (sym) insertReqLink.run(sym.id, ann.reqId);
      }
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

    // SQL extraction: only store a row when the file actually references a
    // table, so query_text doesn't bloat with whole-file copies of plain TS.
    const { queries } = extractSql(content);
    for (const q of queries) {
      if (q.tables.length === 0) continue;
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
  return langForExt(ext) ?? 'unknown';
}

/** Extract `@req <id>` annotations from source comments/JSDoc, returning
 *  the 1-based line number each annotation sits on so the build can link it
 *  to the nearest following symbol declaration. The id is project-defined —
 *  accepts whatever token follows `@req` (REQ-01, R1, FOO-12, …) so this
 *  isn't coupled to one requirement-id scheme. */
export function extractReqAnnotations(content: string): { line: number; reqId: string }[] {
  const out: { line: number; reqId: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const re = /@req\s+([\w-]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const reqId = m[1];
      if (reqId) out.push({ line: i + 1, reqId });
    }
  }
  return out;
}