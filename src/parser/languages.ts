export type NormalizedKind = 'class' | 'method' | 'interface' | 'type' | 'enum' | 'const' | 'unknown';

export interface LanguageConfig {
  wasmFile: string;
  extensions: string[];
  nodeMap: Record<string, NormalizedKind>;
  nameFields: string[];
}

export const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  typescript: {
    wasmFile: 'tree-sitter-typescript.wasm',
    extensions: ['.ts', '.tsx'],
    nodeMap: {
      'class_declaration': 'class',
      'function_declaration': 'method',
      'interface_declaration': 'interface',
      'type_alias_declaration': 'type',
      'enum_declaration': 'enum',
    },
    nameFields: ['name'],
  },
  javascript: {
    wasmFile: 'tree-sitter-javascript.wasm',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    nodeMap: {
      'class_declaration': 'class',
      'function_declaration': 'method',
    },
    nameFields: ['name'],
  },
  python: {
    wasmFile: 'tree-sitter-python.wasm',
    extensions: ['.py'],
    nodeMap: {
      'class_definition': 'class',
      'function_definition': 'method',
    },
    nameFields: ['name'],
  },
  java: {
    wasmFile: 'tree-sitter-java.wasm',
    extensions: ['.java'],
    nodeMap: {
      'class_declaration': 'class',
      'method_declaration': 'method',
      'interface_declaration': 'interface',
    },
    nameFields: ['name'],
  },
  cpp: {
    wasmFile: 'tree-sitter-cpp.wasm',
    extensions: ['.cpp', '.hpp', '.cc', '.cxx'],
    nodeMap: {
      'class_specifier': 'class',
      'function_definition': 'method',
    },
    nameFields: ['declarator', 'name'],
  },
  go: {
    wasmFile: 'tree-sitter-go.wasm',
    extensions: ['.go'],
    nodeMap: {
      'type_declaration': 'class',
      'function_declaration': 'method',
    },
    nameFields: ['name'],
  },
  rust: {
    wasmFile: 'tree-sitter-rust.wasm',
    extensions: ['.rs'],
    nodeMap: {
      'struct_item': 'class',
      'enum_item': 'enum',
      'function_item': 'method',
      'impl_item': 'method',
    },
    nameFields: ['name'],
  },
  c: {
    wasmFile: 'tree-sitter-c.wasm',
    extensions: ['.c', '.h'],
    nodeMap: {
      'function_definition': 'method',
    },
    nameFields: ['declarator', 'name'],
  }
};

/**
 * Single source of truth for extension -> language key. Built once from
 * LANGUAGE_CONFIGS so adding a language there auto-wires it into the build
 * walker (build.ts) and the parser (parse.ts) — no second Set to drift.
 * All extensions are lower-case; callers should lower-case the ext before
 * lookup.
 */
export const EXT_TO_LANG: Map<string, string> = new Map();
for (const [langKey, cfg] of Object.entries(LANGUAGE_CONFIGS)) {
  for (const ext of cfg.extensions) EXT_TO_LANG.set(ext.toLowerCase(), langKey);
}

/** Resolve a file extension to its language key, or undefined if unsupported. */
export function langForExt(ext: string): string | undefined {
  return EXT_TO_LANG.get(ext.toLowerCase());
}
