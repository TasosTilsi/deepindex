import type Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { IGNORED_DIRS } from '../graph/build.js';

// Knowledge-source corpus builders (D-25/D-27/D-27b/D-27c): pure functions of
// db rows (+ one fs read per markdown file). The embedded text for every doc
// is deterministic, so the hash guard in the embed lifecycle can decide
// staleness without loading any model.

export interface SemanticDoc {
  kind: 'entity' | 'symbol' | 'module' | 'doc';
  id: string;
  label: string;
  text: string;
  /** Owning file path for symbol/module/doc kinds; NULL for entities (their
   *  text is a pure function of db rows — always hash-checked, cheap). */
  sourcePath: string | null;
}

/** Entity docs (D-25): type + name + content. */
export function entityDocs(db: Database.Database): SemanticDoc[] {
  const rows = db
    .prepare('SELECT id, type, name, content FROM entities')
    .all() as { id: string; type: string; name: string; content: string }[];
  return rows.map((r) => ({
    kind: 'entity',
    id: r.id,
    label: r.name,
    text: `${r.type}: ${r.name}\n${r.content}`,
    sourcePath: null,
  }));
}

/** Symbol docs (D-25/D-27c): name, kind, path, docstring. Docstring may be
 *  '' — comment-thin repos degrade gracefully (KSRC-03). */
export function symbolDocs(db: Database.Database): SemanticDoc[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.docstring, f.path
       FROM symbols s JOIN files f ON f.id = s.file_id`
    )
    .all() as { id: number; name: string; kind: string; docstring: string; path: string }[];
  return rows.map((r) => ({
    kind: 'symbol',
    id: `sym:${r.id}`,
    label: r.name,
    text: `${r.name} (${r.kind})\n${r.path}\n${r.docstring ?? ''}`,
    sourcePath: r.path,
  }));
}

/** Module cards (KSRC-01, D-27): per CODE file — exports, distinct
 *  imports-out, imported-by (resolved imports), tables touched. Pure
 *  function of db rows (POC SQL template, RESEARCH §1.3).
 *
 *  `.md` file rows are EXCLUDED (checker F-5): the files table includes
 *  markdown (it is a supported language), which would yield near-empty
 *  duplicate cards and break the POC corpus arithmetic — md content is
 *  covered by markdownChunks with kind 'doc' instead. */
export function moduleCards(db: Database.Database): SemanticDoc[] {
  const fileRows = db
    .prepare('SELECT id, path FROM files')
    .all() as { id: number; path: string }[];
  const getExports = db.prepare(
    'SELECT name, kind FROM symbols WHERE file_id = ? AND exported = 1'
  );
  const getImportsOut = db.prepare(
    'SELECT DISTINCT source FROM imports WHERE file_id = ?'
  );
  const getImportedBy = db.prepare(
    `SELECT DISTINCT f.path FROM imports i JOIN files f ON f.id = i.file_id
     WHERE i.resolved_file_id = ?`
  );
  const getTables = db.prepare(
    `SELECT DISTINCT qt.table_name FROM query_tables qt
     JOIN sql_queries q ON q.id = qt.query_id WHERE q.file_id = ?`
  );

  const cards: SemanticDoc[] = [];
  for (const file of fileRows) {
    if (file.path.toLowerCase().endsWith('.md')) continue;
    const lines: string[] = [];
    const exports = getExports.all(file.id) as { name: string; kind: string }[];
    if (exports.length > 0) {
      lines.push(`exports: ${exports.map((e) => e.name).join(', ')}`);
    }
    const importsOut = getImportsOut.all(file.id) as { source: string }[];
    if (importsOut.length > 0) {
      lines.push(`imports-out: ${importsOut.map((i) => i.source).join(', ')}`);
    }
    const importedBy = getImportedBy.all(file.id) as { path: string }[];
    if (importedBy.length > 0) {
      lines.push(`imported-by: ${importedBy.map((i) => i.path).join(', ')}`);
    }
    const tables = getTables.all(file.id) as { table_name: string }[];
    if (tables.length > 0) {
      lines.push(`tables: ${tables.map((t) => t.table_name).join(', ')}`);
    }
    cards.push({
      kind: 'module',
      id: `module:${file.path}`,
      label: file.path,
      text: lines.join('\n'),
      sourcePath: file.path,
    });
  }
  return cards;
}

const MD_CHUNK_CAP = 700;

/** Markdown docs (KSRC-02, D-27b): walk disk for *.md, skip IGNORED_DIRS and
 *  every dot-directory, split at #{1,3} heading boundaries, chunk = heading
 *  + body prefixed with the path, clamped at 700 chars (POC values, OQ-12).
 *  Reuses the exported IGNORED_DIRS from build.ts so the corpus walk never
 *  diverges from the index walk. */
export function markdownChunks(rootDir: string): SemanticDoc[] {
  const chunks: SemanticDoc[] = [];
  for (const relPath of walkMarkdown(rootDir)) {
    const raw = readFileSync(join(rootDir, relPath), 'utf8');
    const lines = raw.split('\n');
    const groups: string[][] = [];
    let current: string[] = [];
    for (const line of lines) {
      if (/^#{1,3}\s/.test(line)) {
        if (current.length > 0) groups.push(current);
        current = [line];
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) groups.push(current);
    for (const [i, group] of groups.entries()) {
      const body = group.join('\n').trim();
      if (body.length === 0) continue;
      const text = `${relPath} — ${body}`.slice(0, MD_CHUNK_CAP);
      chunks.push({
        kind: 'doc',
        id: `doc:${relPath}#${i}`,
        label: relPath,
        text,
        sourcePath: relPath,
      });
    }
  }
  return chunks;
}

function walkMarkdown(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
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
      if (name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile() && name.toLowerCase().endsWith('.md')) {
        out.push(full.slice(root.length + 1));
      }
    }
  }
  return out;
}

/** First non-blank line of a doc text, clamped ~160 chars (OQ-12). Lives here
 *  (corpus-utility layer) so embed.ts and search-hybrid.ts share one copy
 *  (REVIEW-FIX: embed persists it at embed time; vecHits reads it from meta). */
export function firstLine(text: string, max = 160): string {
  const line = (text.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** Full embedded corpus: entities + symbols + module cards + markdown docs
 *  (POC arithmetic: 628 = 377 entity+symbol docs + 57 code-file cards + 194
 *  md chunks on this repo). */
export function buildCorpus(db: Database.Database, rootDir: string): SemanticDoc[] {
  return [
    ...entityDocs(db),
    ...symbolDocs(db),
    ...moduleCards(db),
    ...markdownChunks(rootDir),
  ];
}