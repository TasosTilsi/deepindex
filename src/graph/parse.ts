import { Parser, Language, type Node as SyntaxNode } from 'web-tree-sitter';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGUAGE_CONFIGS, langForExt, type LanguageConfig, type NormalizedKind } from '../parser/languages.js';

export interface ParsedSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  complexity: number;
  /** Comment block immediately preceding the declaration (D-27c), stripped
   *  of comment markers, clamped at 400 chars. '' when none — comment-thin
   *  repos degrade gracefully (KSRC-03). */
  docstring: string;
}

export interface ParsedImport {
  source: string;
  /** Java only: `import static a.b.C.member;` — the last segment is a member. */
  isStatic?: boolean;
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
    if (!existsSync(wasmPath)) {
      throw new GrammarUnavailableError(langKey, wasmPath);
    }
    return Language.load(readFileSync(wasmPath));
  })();

  langCache.set(langKey, promise);
  return promise;
}

const parserCache = new Map<Language, Parser>();

// Extension -> language resolution uses the single source of truth exported
// from languages.ts (EXT_TO_LANG / langForExt), shared with build.ts.

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

  const langKey = langForExt(ext);
  if (!langKey) return { symbols: [], imports: [] };

  try {
    const lang = await getLanguage(langKey);
    const parser = await getParser(lang);
    const tree = parser.parse(content);
    if (!tree) return { symbols: [], imports: [] };

    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];

    collectSymbols(tree.rootNode, symbols, langKey);
    collectImports(tree.rootNode, imports, langKey);

    return { symbols, imports };
  } catch (e) {
    // Missing grammar (e.g. a language whose .wasm isn't vendored) is not an
    // error — skip the file silently. Real parse errors are logged.
    if (e instanceof GrammarUnavailableError) return { symbols: [], imports: [] };
    console.error(`Parsing error for ${filePath} (${langKey}):`, e);
    return { symbols: [], imports: [] };
  }
}

/** Thrown when a language's tree-sitter grammar .wasm isn't vendored. */
class GrammarUnavailableError extends Error {
  constructor(langKey: string, wasmPath: string) {
    super(`Grammar not available for ${langKey}: ${wasmPath}`);
    this.name = 'GrammarUnavailableError';
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
        // Docstring comments are siblings of the export_statement itself, not
        // of the inner declaration — walk from the outer node.
        const sym = nodeToSymbol(child, langKey, node);
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
              docstring: extractDocstring(node),
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
          docstring: extractDocstring(node),
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

/** Docstring capture (D-27c): walk previousNamedSibling backwards collecting
 *  consecutive comment nodes, stopping at the first non-comment sibling.
 *  Strip comment markers per line, drop blank lines, clamp at 400 chars
 *  (OQ-12 — POC docstring cap). '' when the symbol has no preceding comment
 *  (comment-thin repos degrade gracefully — KSRC-03). */
function extractDocstring(node: SyntaxNode): string {
  const parts: string[] = [];
  let sibling: SyntaxNode | null = node.previousNamedSibling;
  while (sibling && sibling.type.includes('comment')) {
    parts.unshift(sibling.text);
    sibling = sibling.previousNamedSibling;
  }
  if (parts.length === 0) return '';
  const stripped = parts
    .join('\n')
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*\/\/\s?/, '')
        .replace(/^\s*\/\*+\s?/, '')
        .replace(/\s*\*+\/\s*$/, '')
        .replace(/^\s*\*+\s?/, '')
        .trimEnd()
    )
    .filter((line) => line.length > 0);
  const text = stripped.join('\n');
  return text.length > 400 ? text.slice(0, 400) : text;
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

/**
 * Issue #13: a language without an `export` keyword never produces an
 * `export_statement`, so its symbols stayed exported = false and the edge builder —
 * which needs an exported symbol on both sides — skipped every one of its files. A
 * Java member is importable unless it is private.
 */
function isExportedByDefault(node: SyntaxNode, config: LanguageConfig): boolean {
  // Rust is the inverse case: `pub` marks what is importable, so no modifier means private.
  // Reading it with the Java rule would have exported every private item in the crate.
  if (config.exportedByVisibility) {
    const visibility = node.namedChildren.find((child) => child.type === 'visibility_modifier');
    return visibility ? visibility.text.trim().startsWith(config.exportedByVisibility) : false;
  }
  if (!config.exportedByDefault) return false;
  const modifiers =
    node.childForFieldName('modifiers') ?? node.namedChildren.find((c) => c.type === 'modifiers');
  if (modifiers) return !/\bprivate\b/.test(modifiers.text);
  // C and C++ mark the file-scope symbols with `static` where Java uses `private`.
  const storage = node.namedChildren.find((c) => c.type === 'storage_class_specifier');
  if (storage) return !/\bstatic\b/.test(storage.text);
  return true;
}

function nodeToSymbol(
  node: SyntaxNode,
  langKey: string,
  docNode: SyntaxNode = node
): ParsedSymbol | null {
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
    // Fallback: some grammars (kotlin, dart, etc.) name declarations via a
    // type_identifier/identifier child rather than a `name` field.
    const id = node.namedChildren.find((c) => c.type === 'type_identifier' || c.type === 'identifier');
    if (id) name = id.text;
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
    exported: isExportedByDefault(node, config),
    complexity: calculateComplexity(node),
    docstring: extractDocstring(docNode),
  };
}

function collectImports(node: SyntaxNode, out: ParsedImport[], langKey: string): void {
  // Issue #20. Python's imports carry no `source` field: `import a.b, c.d` has one `dotted_name`
  // per module (an `aliased_import` when there is an `as`), and `from .mod import x` is an
  // `import_from_statement` whose `module_name` field is a `relative_import` or a `dotted_name` —
  // its other `dotted_name` children are the imported NAMES, so the field is the only safe reading.
  // Shapes measured against the grammar; before this branch Python produced no import rows at all,
  // which is why setting its export flag alone would have changed nothing.
  // Issue #20, the C family. `#include "x.h"` is a `preproc_include` whose `path` field is a
  // string_literal; `<x.h>` is a system_lib_string and names no file in this repository, so it
  // produces no row at all.
  if ((langKey === 'c' || langKey === 'cpp' || langKey === 'objc') && node.type === 'preproc_include') {
    const included = node.childForFieldName('path');
    if (included && included.type === 'string_literal') {
      out.push({ source: included.text.replace(/^"|"$/g, '') });
    }
    return;
  }

  // Issue #20, Ruby. `require_relative 'helper'` is a `call` to that method with the path in its
  // argument list. It is normalised to `./helper` so that a miss is broken by the same rule every
  // relative import uses; a bare `require 'json'` stays bare and is left to the external verdict.
  if (langKey === 'ruby' && node.type === 'call') {
    const method =
      node.childForFieldName('method') ?? node.namedChildren.find((child) => child.type === 'identifier');
    const args = node.childForFieldName('arguments');
    if (!method || !args) return;
    const literal = args.namedChildren.find((child) => child.type === 'string');
    if (!literal) return;
    const text = literal.text.replace(/^['"]|['"]$/g, '');
    if (method.text === 'require_relative') {
      out.push({ source: text.startsWith('.') ? text : `./${text}` });
    } else if (method.text === 'require') {
      // Kept as written: `./x` is relative to the file, anything else is a gem or the standard
      // library and becomes an external row like `import express` or `import os` do elsewhere.
      out.push({ source: text });
    }
    return;
  }

  // Issue #20, Rust. Measured shapes: `use crate::a::b;` is a `use_declaration` whose `argument`
  // field holds the path; `use a::b::{C, D};` is a `scoped_use_list` whose text carries the braces;
  // and `mod helpers;` is a `mod_item` naming a sibling file (`mod x { .. }` names none).
  if (langKey === 'rust' && (node.type === 'use_declaration' || node.type === 'mod_item')) {
    if (node.type === 'mod_item') {
      const name = node.childForFieldName('name');
      const inline = node.namedChildren.some((child) => child.type === 'declaration_list');
      if (name && !inline) out.push({ source: `self::${name.text}` });
      return;
    }
    const argument = node.childForFieldName('argument');
    if (!argument) return;
    const source = argument.text
      .replace(/\s*::\s*\{[\s\S]*$/, '') // use a::b::{C, D};
      .replace(/\s*::\s*\*$/, '') // use a::b::*;
      .replace(/\s+as\s+[\s\S]*$/, '') // use a::b as c;
      .trim();
    if (source) out.push({ source });
    return;
  }

  if (
    langKey === 'python' &&
    (node.type === 'import_statement' || node.type === 'import_from_statement')
  ) {
    if (node.type === 'import_statement') {
      for (const child of node.namedChildren) {
        if (child.type === 'dotted_name') out.push({ source: child.text });
        else if (child.type === 'aliased_import') {
          // `import pkg.mod as m` names pkg.mod; the alias is not part of the path.
          out.push({ source: child.text.replace(/\s+as\s+[\s\S]*$/, '') });
        }
      }
      return;
    }
    const module = node.childForFieldName('module_name');
    if (module) out.push({ source: module.text });
    return;
  }

  if (node.type === 'import_statement') {
    const src = node.childForFieldName('source');
    if (src) {
      const s = src.text.replace(/^['"]|['"]$/g, '');
      out.push({ source: s });
    }
    return;
  }

  // Issue #5: Java emits `import_declaration` with a `scoped_identifier` child and no
  // `source` field, so before this branch Java contributed no import rows at all. Gated
  // on the language: tree-sitter-scala also emits `import_declaration`, with different
  // children.
  if (langKey === 'java' && node.type === 'import_declaration') {
    // `import com.a.B;` arrives as a `scoped_identifier`, but `import Rooted;` — a type in the
    // default package — is a bare `identifier`. Matching only the dotted form dropped those rows
    // silently, which is how the class map could never see them.
    const scoped = node.namedChildren.find(
      (child) => child.type === 'scoped_identifier' || child.type === 'identifier'
    );
    if (scoped) {
      const wildcard = node.namedChildren.some((child) => child.type === 'asterisk');
      out.push({
        source: wildcard ? `${scoped.text}.*` : scoped.text,
        isStatic: /^import\s+static\s/.test(node.text),
      });
    }
    return;
  }

  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c) collectImports(c, out, langKey);
  }
}
