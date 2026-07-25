import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ParsedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
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

const TS_WASM = join(WASM_DIR, 'tree-sitter-typescript.wasm');
const JS_WASM = join(WASM_DIR, 'tree-sitter-javascript.wasm');

const TS_LANG_PROMISE: Promise<Language> = (async () => {
  await initOnce();
  return Language.load(readFileSync(TS_WASM));
})();

const JS_LANG_PROMISE: Promise<Language> = (async () => {
  await initOnce();
  return Language.load(readFileSync(JS_WASM));
})();

const parserCache = new Map<Language, Parser>();

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
  let lang: Language | null = null;
  if (ext === '.ts' || ext === '.tsx') {
    lang = await TS_LANG_PROMISE;
  } else if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
    lang = await JS_LANG_PROMISE;
  }
  if (!lang) return { symbols: [], imports: [] };

  const parser = await getParser(lang);
  const tree = parser.parse(content);
  if (!tree) return { symbols: [], imports: [] };
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];

  collectSymbols(tree.rootNode, symbols);
  collectImports(tree.rootNode, imports);

  return { symbols, imports };
}

function collectSymbols(node: SyntaxNode, out: ParsedSymbol[]): void {
  const kind = node.type;
  if (kind === 'export_statement') {
    // export_statement can wrap: function_declaration, class_declaration,
    // interface_declaration, type_alias_declaration, enum_declaration, OR
    // lexical_declaration (export const X = ...).
    const child = node.firstNamedChild;
    if (child) {
      if (
        child.type === 'function_declaration' ||
        child.type === 'class_declaration' ||
        child.type === 'interface_declaration' ||
        child.type === 'type_alias_declaration' ||
        child.type === 'enum_declaration'
      ) {
        const sym = nodeToSymbol(child);
        if (sym) {
          sym.exported = true;
          out.push(sym);
        }
      } else if (child.type === 'lexical_declaration') {
        // extract each declarator as a symbol
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
            });
          }
        }
      }
    }
    return; // do not recurse — handled
  }
  if (
    kind === 'function_declaration' ||
    kind === 'class_declaration' ||
    kind === 'interface_declaration' ||
    kind === 'type_alias_declaration' ||
    kind === 'enum_declaration'
  ) {
    const sym = nodeToSymbol(node);
    if (sym) out.push(sym);
  } else if (kind === 'lexical_declaration') {
    // Handles `const X = ...` and `let Y = ...` (with or without export wrapper)
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
        });
      }
    }
    return; // don't recurse into lexical_declaration's children — already handled
  }
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectSymbols(c, out);
  }
}

function nodeToSymbol(node: SyntaxNode): ParsedSymbol | null {
  let name: string | null = null;
  let kind = 'unknown';
  if (node.type === 'function_declaration') {
    kind = 'function';
    const n = node.childForFieldName('name');
    if (n) name = n.text;
  } else if (node.type === 'class_declaration') {
    kind = 'class';
    const n = node.childForFieldName('name');
    if (n) name = n.text;
  } else if (node.type === 'interface_declaration') {
    kind = 'interface';
    const n = node.childForFieldName('name');
    if (n) name = n.text;
  } else if (node.type === 'type_alias_declaration') {
    kind = 'type';
    const n = node.childForFieldName('name');
    if (n) name = n.text;
  } else if (node.type === 'enum_declaration') {
    kind = 'enum';
    const n = node.childForFieldName('name');
    if (n) name = n.text;
  }
  if (!name) return null;
  return {
    name,
    kind,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    exported: false,
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
