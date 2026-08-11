export interface SqlQuery {
  text: string;
  tables: string[];
}

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
];

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
 *  (SQL, ORM annotations, or MongoDB calls). */
export function extractTables(text: string): string[] {
  const stripped = stripComments(text);
  return Array.from(new Set([...collectMatches(stripped, TABLE_PATTERNS), ...collectMatches(stripped, ORM_PATTERNS)]));
}

/** Whole-text extraction: returns one SqlQuery covering the whole block with
 *  all referenced tables merged. Callers insert one row per file. */
export function extractSql(text: string): { queries: SqlQuery[] } {
  const tables = extractTables(text);
  return { queries: [{ text, tables }] };
}