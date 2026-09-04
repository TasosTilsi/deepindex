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
  },
  php: {
    wasmFile: 'tree-sitter-php.wasm',
    extensions: ['.php'],
    nodeMap: {
      'class_declaration': 'class',
      'function_definition': 'method',
      'interface_declaration': 'interface',
      'enum_declaration': 'enum',
    },
    nameFields: ['name'],
  },
  ruby: {
    wasmFile: 'tree-sitter-ruby.wasm',
    extensions: ['.rb'],
    nodeMap: {
      'class': 'class',
      'method': 'method',
      'module': 'class',
    },
    nameFields: ['name'],
  },
  c_sharp: {
    wasmFile: 'tree-sitter-c_sharp.wasm',
    extensions: ['.cs'],
    nodeMap: {
      'class_declaration': 'class',
      'method_declaration': 'method',
      'interface_declaration': 'interface',
      'enum_declaration': 'enum',
    },
    nameFields: ['name'],
  },
  swift: {
    wasmFile: 'tree-sitter-swift.wasm',
    extensions: ['.swift'],
    nodeMap: {
      'class_declaration': 'class',
      'function_declaration': 'method',
      'struct_declaration': 'class',
      'enum_declaration': 'enum',
    },
    nameFields: ['name'],
  },
  kotlin: {
    wasmFile: 'tree-sitter-kotlin.wasm',
    extensions: ['.kt', '.kts'],
    nodeMap: {
      'class_declaration': 'class',
      'function_declaration': 'method',
      'interface_declaration': 'interface',
    },
    nameFields: ['name'],
  },
  scala: {
    wasmFile: 'tree-sitter-scala.wasm',
    extensions: ['.scala', '.sc'],
    nodeMap: {
      'class_definition': 'class',
      'function_definition': 'method',
      'trait_definition': 'interface',
    },
    nameFields: ['name'],
  },
  bash: {
    wasmFile: 'tree-sitter-bash.wasm',
    extensions: ['.sh', '.bash'],
    nodeMap: {
      'function_definition': 'method',
    },
    nameFields: ['name'],
  },
  dart: {
    wasmFile: 'tree-sitter-dart.wasm',
    extensions: ['.dart'],
    nodeMap: {
      'class_definition': 'class',
      'method_signature': 'method',
      'mixin_declaration': 'class',
    },
    nameFields: ['name'],
  },
  lua: {
    wasmFile: 'tree-sitter-lua.wasm',
    extensions: ['.lua'],
    nodeMap: {
      'function_declaration': 'method',
    },
    nameFields: ['name'],
  },
  elixir: {
    wasmFile: 'tree-sitter-elixir.wasm',
    extensions: ['.ex', '.exs'],
    nodeMap: {
      'def': 'method',
      'defmodule': 'class',
    },
    nameFields: ['name'],
  },
  objc: {
    wasmFile: 'tree-sitter-objc.wasm',
    extensions: ['.m', '.mm'],
    nodeMap: {
      'class_interface': 'class',
      'method_definition': 'method',
    },
    nameFields: ['name'],
  },
  html: {
    wasmFile: 'tree-sitter-html.wasm',
    extensions: ['.html', '.htm'],
    nodeMap: {},
    nameFields: ['name'],
  },
  css: {
    wasmFile: 'tree-sitter-css.wasm',
    extensions: ['.css'],
    nodeMap: {},
    nameFields: ['name'],
  },
  json: {
    wasmFile: 'tree-sitter-json.wasm',
    extensions: ['.json'],
    nodeMap: {},
    nameFields: ['name'],
  },
  yaml: {
    wasmFile: 'tree-sitter-yaml.wasm',
    extensions: ['.yaml', '.yml'],
    nodeMap: {},
    nameFields: ['name'],
  },
  markdown: {
    wasmFile: 'tree-sitter-markdown.wasm',
    extensions: ['.md', '.markdown'],
    nodeMap: {},
    nameFields: ['name'],
  },
  vue: {
    wasmFile: 'tree-sitter-vue.wasm',
    extensions: ['.vue'],
    nodeMap: {},
    nameFields: ['name'],
  },
  svelte: {
    wasmFile: 'tree-sitter-svelte.wasm',
    extensions: ['.svelte'],
    nodeMap: {},
    nameFields: ['name'],
  },
  perl: {
    wasmFile: 'tree-sitter-perl.wasm',
    extensions: ['.pl', '.pm'],
    nodeMap: {},
    nameFields: ['name'],
  },
  r: {
    wasmFile: 'tree-sitter-r.wasm',
    extensions: ['.r', '.R'],
    nodeMap: {},
    nameFields: ['name'],
  },
  haskell: {
    wasmFile: 'tree-sitter-haskell.wasm',
    extensions: ['.hs'],
    nodeMap: {},
    nameFields: ['name'],
  },
  clojure: {
    wasmFile: 'tree-sitter-clojure.wasm',
    extensions: ['.clj', '.cljs'],
    nodeMap: {},
    nameFields: ['name'],
  },
  erlang: {
    wasmFile: 'tree-sitter-erlang.wasm',
    extensions: ['.erl'],
    nodeMap: {},
    nameFields: ['name'],
  },
  zig: {
    wasmFile: 'tree-sitter-zig.wasm',
    extensions: ['.zig'],
    nodeMap: {},
    nameFields: ['name'],
  },
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
