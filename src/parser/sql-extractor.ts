import { parse, cstVisitor, type Node } from 'sql-parser-cst';

export interface SqlQuery {
  text: string;
  tables: string[];
}

/**
 * Dual-path SQL & data-flow extractor.
 *
 *   - Regex path: cheap, covers SQL keywords + ORM + Mongo annotations.
 *   - Formal path: sql-parser-cst CST walk for queries the regex path misses
 *     (correlated subqueries, dialect-specific syntax).
 *
 * The coordinator (`extractSql`) runs both and merges, preferring the union
 * so neither path silently drops a table reference.
 */

const TABLE_PATTERNS = [
  /\bFROM\s+([\w.]+)/gi,
  /\bJOIN\s+([\w.]+)/gi,
  /\bINTO\s+([\w.]+)/gi,
  /\bUPDATE\s+([\w.]+)/gi,
  /\bTABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([\w.]+)/gi,
];

const ORM_PATTERNS = [
  /@Table\s*\(\s*name\s*=\s*["']([\w.]+)["']\s*\)/gi,
  /@Entity\s*\(\s*name\s*=\s*["']([\w.]+)["']\s*\)/gi,
  /db\.collection\s*\(\s*["']([\w.]+)["']\s*\)/gi,
  /db\.getCollection\s*\(\s*["']([\w.]+)["']\s*\)/gi,
];

/** Config-mapping patterns: Hibernate-style XML and YAML entity mappings.
 *  Kept out of TABLE_PATTERNS so plain SQL/code isn't accidentally scanned
 *  for `table="..."` — callers run `extractConfigMappings` only on config files. */
const XML_TABLE_PATTERN = /\btable\s*=\s*["']([\w.]+)["']/g;
const YAML_TABLE_PATTERN = /^[ \t]*table:[ \t]*([\w.-]+)/gm;

/** Remove comments (block /* *\/, line //, --, #) so SQL keyword regexes
 *  don't match table names inside commented-out code. String literals are
 *  intentionally NOT stripped — too risky for correctness. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ');
}

function collectMatches(text: string, patterns: RegExp[]): Set<string> {
  const out = new Set<string>();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) out.add(match[1]);
    }
  }
  return out;
}

/** Extract referenced table/collection names from a block of source text
 *  (SQL, ORM annotations, or MongoDB calls) via the regex path. */
export function extractTables(text: string): string[] {
  const stripped = stripComments(text);
  return Array.from(
    new Set([...collectMatches(stripped, TABLE_PATTERNS), ...collectMatches(stripped, ORM_PATTERNS)]),
  );
}

/** Split a CREATE TABLE column-definition list on top-level commas, respecting
 *  nested parentheses (Case 1: `id INT, meta JSON(10,2), PRIMARY KEY (id)`).
 *  Accepts the inner list text or a string wrapped in an outer paren group. */
export function splitColumnDefinitions(text: string): string[] {
  let s = text.trim();
  // Strip one outer paren wrapper if present.
  if (s.startsWith('(') && s.endsWith(')')) {
    // Only strip if the outer parens are balanced as a single group.
    let depth = 0;
    let wrapsAll = true;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0 && i !== s.length - 1) {
          wrapsAll = false;
          break;
        }
      }
    }
    if (wrapsAll) s = s.slice(1, -1);
  }
  if (s.trim() === '') return [];

  const out: string[] = [];
  let depth = 0;
  let start = 0;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      const seg = s.slice(start, i).trim();
      if (seg) out.push(seg);
      start = i + 1;
    }
  }
  const last = s.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Recursively collect identifier names that represent table references. */
function collectIdentifiers(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectIdentifiers(n, into);
    return;
  }
  const n = node as { type?: string; name?: string };
  if (n.type === 'identifier' && n.name) {
    into.add(n.name);
    return;
  }
  for (const k of Object.keys(n)) {
    if (k === 'loc' || k === 'type') continue;
    const v = (n as Record<string, unknown>)[k];
    if (v && typeof v === 'object') collectIdentifiers(v, into);
  }
}

/** Formal path: parse SQL with sql-parser-cst and walk the CST for table
 *  references. Returns an empty array on unparseable input — callers fall
 *  back to the regex path. Uses the sqlite dialect as a permissive default
 *  (it accepts the common SELECT/INSERT/UPDATE/DELETE/CREATE grammar). */
export function extractTablesFormal(sql: string): string[] {
  try {
    const cst = parse(sql, { dialect: 'sqlite' });
    const tables = new Set<string>();
    // ponytail: FROM/JOIN intentionally NOT visited formally — collectIdentifiers
    // recurses the whole subtree and captures table aliases + ON-condition column
    // names (u, o, id, user_id) alongside real tables, polluting query_tables and
    // corrupting analyze-impact/find-table-usage/check-parallel-storage. The regex
    // path (TABLE_PATTERNS: FROM/JOIN/INTO/UPDATE/TABLE) already covers SELECT/JOIN
    // and subqueries cleanly via the coordinator's union merge, so the formal path
    // only needs to handle statements the regex misses: CREATE/INSERT/UPDATE/DELETE.
    const visit = cstVisitor({
      create_table_stmt: (n) => collectIdentifiers((n as { name: unknown }).name, tables),
      insert_clause: (n) => collectIdentifiers((n as { table: unknown }).table, tables),
      update_clause: (n) => collectIdentifiers((n as { tables: unknown }).tables, tables),
      delete_clause: (n) => collectIdentifiers((n as { tables: unknown }).tables, tables),
    });
    visit(cst as Node);
    return Array.from(tables);
  } catch {
    return [];
  }
}

/** Extract table names from XML/YAML config mappings (Hibernate, JPA, YAML
 *  entity definitions). Callers should only run this on .xml/.yaml/.yml files
 *  so plain SQL/code isn't scanned for `table="..."`. */
export function extractConfigMappings(text: string): string[] {
  const out = new Set<string>();
  XML_TABLE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = XML_TABLE_PATTERN.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  YAML_TABLE_PATTERN.lastIndex = 0;
  while ((m = YAML_TABLE_PATTERN.exec(text)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

const SQL_KEYWORD_RE = /\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|JOIN|INTO)\b/i;

/** Coordinator: whole-text extraction. Runs the regex path always, and the
 *  formal path when the text looks like SQL, merging both. Returns one
 *  SqlQuery covering the whole block with all referenced tables merged —
 *  callers insert one row per file. */
export function extractSql(text: string): { queries: SqlQuery[] } {
  const regexTables = new Set(extractTables(text));
  let usedFormal = false;
  if (SQL_KEYWORD_RE.test(text)) {
    const formal = extractTablesFormal(text);
    if (formal.length > 0) {
      usedFormal = true;
      for (const t of formal) regexTables.add(t);
    }
  }
  if (process.env.DEBUG_DEEPINIT) {
    // eslint-disable-next-line no-console
    console.debug(
      `[sql-extractor] regex=${extractTables(text).length} formal-used=${usedFormal} merged=${regexTables.size}`,
    );
  }
  return { queries: [{ text, tables: Array.from(regexTables) }] };
}