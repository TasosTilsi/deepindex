import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_CONFIGS, type NormalizedKind } from '../parser/languages.js';

export interface ParsedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  complexity: number;
}

export interface ParsedImport {
  source: string;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
}

let _initPromise: Promise<void> | null = null;
function initOnce(): Promise<void> {
  if (!_initPromise) {
    _initPromise = Parser.init();
  }
  return _initPromise;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WASM_DIR = resolve(__dirname, '../../.tree-sitter');

const langCache = new Map<string, Promise<Language>>();

async function getLanguage(langKey: string): Promise<Language> {
  if (langCache.has(langKey)) return langCache.get(langKey)!;

  const config = LANGUAGE_CONFIGS[langKey];
  if (!config) throw new Error(`Unsupported language: ${langKey}`);

  const promise = (async () => {
    await initOnce();
    const wasmPath = join(WASM_DIR, config.wasmFile);
    return Language.load(readFileSync(wasmPath));
  })();

  langCache.set(langKey, promise);
  return promise;
}

const parserCache = new Map<Language, Parser>();

// Built once at module load so parseFile resolves a language by extension in
// O(1) instead of scanning LANGUAGE_CONFIGS per file.
const EXT_TO_LANG = new Map<string, string>();
for (const [langKey, cfg] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of cfg.extensions) EXT_TO_LANG.set(ext, langKey);
}

async function getParser(lang: Language): Promise<Parser> {
  let p = parserCache.get(lang);
  if (!p) {
    p = new Parser();
    p.setLanguage(lang);
    parserCache.set(lang, p);
  }
  return p;
}

export async function parseFile(
  filePath: string,
  content: string,
  extHint?: string
): Promise<ParseResult> {
  const ext = extHint ?? filePath.slice(filePath.lastIndexOf('.'));

  const langKey = EXT_TO_LANG.get(ext);
  if (!langKey) return { symbols: [], imports: [] };

  try {
    const lang = await getLanguage(langKey);
    const parser = await getParser(lang);
    const tree = parser.parse(content);
    if (!tree) return { symbols: [], imports: [] };

    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];

    collectSymbols(tree.rootNode, symbols, langKey);
    collectImports(tree.rootNode, imports);

    return { symbols, imports };
  } catch (e) {
    console.error(`Parsing error for ${filePath} (${langKey}):`, e);
    return { symbols: [], imports: [] };
  }
}

function collectSymbols(node: SyntaxNode, out: ParsedSymbol[], langKey: string): void {
  const config = LANGUAGE_CONFIGS[langKey];
  if (!config) return;
  const kind = node.type;

  if (kind === 'export_statement') {
    const child = node.firstNamedChild;
    if (child) {
      const normalized = config.nodeMap[child.type];
      if (normalized) {
        const sym = nodeToSymbol(child, langKey);
        if (sym) {
          sym.exported = true;
          out.push(sym);
        }
      } else if (child.type === 'lexical_declaration') {
        const decls = child.descendantsOfType('variable_declarator');
        for (const d of decls) {
          const nameNode = d.childForFieldName('name');
          if (nameNode && nameNode.type === 'identifier') {
            out.push({
              name: nameNode.text,
              kind: 'const',
              startLine: child.startPosition.row,
              endLine: child.endPosition.row,
              exported: true,
              complexity: 0,
            });
          }
        }
      }
    }
    return;
  }

  const normalized = config.nodeMap[kind];
  if (normalized) {
    const sym = nodeToSymbol(node, langKey);
    if (sym) out.push(sym);
  } else if (kind === 'lexical_declaration') {
    const decls = node.descendantsOfType('variable_declarator');
    for (const d of decls) {
      const nameNode = d.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier') {
        out.push({
          name: nameNode.text,
          kind: 'const',
          startLine: node.startPosition.row,
          endLine: node.endPosition.row,
          exported: false,
          complexity: 0,
        });
      }
    }
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectSymbols(c, out, langKey);
  }
}

function calculateComplexity(node: SyntaxNode): number {
  const text = node.text;
  const patterns = [/\bif\b/g, /\bfor\b/g, /\bwhile\b/g, /\bswitch\b/g, /&&/g, /\|\|/g, /\?/g];
  let count = 1;
  for (const p of patterns) {
    const matches = text.match(p);
    if (matches) count += matches.length;
  }
  return count;
}

function nodeToSymbol(node: SyntaxNode, langKey: string): ParsedSymbol | null {
  const config = LANGUAGE_CONFIGS[langKey];
  if (!config) return null;
  let name: string | null = null;

  for (const field of config.nameFields) {
    const n = node.childForFieldName(field);
    if (n) {
      // C/C++: declarator field yields a function_declarator whose .text
      // includes the parameter list (e.g. "my_func()"). Descend to the
      // inner declarator identifier to get the bare name.
      if (n.type === 'function_declarator') {
        const inner = n.childForFieldName('declarator');
        if (inner) {
          name = inner.text;
          break;
        }
      }
      name = n.text;
      break;
    }
  }

  if (!name) {
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c && c.type === 'identifier') {
        name = c.text;
        break;
      }
    }
  }

  if (!name) return null;

  return {
    name,
    kind: config.nodeMap[node.type] || 'unknown',
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    exported: false,
    complexity: calculateComplexity(node),
  };
}

function collectImports(node: SyntaxNode, out: ParsedImport[]): void {
  if (node.type === 'import_statement') {
    const src = node.childForFieldName('source');
    if (src) {
      const s = src.text.replace(/^['"]|['"]$/g, '');
      out.push({ source: s });
    }
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectImports(c, out);
  }
}
