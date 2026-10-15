import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGE_CONFIGS } from '../src/parser/languages.js';

/**
 * The grammar inventory, in both directions.
 *
 * A pre-release review measured this hole: deleting `zig` from `LANGUAGE_CONFIGS` left 472/472
 * passing, and so did deleting `.tree-sitter/tree-sitter-zig.wasm`. Eight of the declared grammars
 * (html, css, vue, svelte, haskell, clojure, erlang, zig) had no test that parsed anything, so their
 * declared support was unverified in both directions — a config whose grammar is missing, and a
 * grammar nothing declares.
 */
describe('the grammar inventory', () => {
  const wasmDir = join(process.cwd(), '.tree-sitter');
  const shipped = readdirSync(wasmDir).filter((name) => name.endsWith('.wasm'));

  it('ships a wasm for every declared language', () => {
    for (const [key, config] of Object.entries(LANGUAGE_CONFIGS)) {
      expect(config.wasmFile, `${key} declares a grammar file`).toMatch(/\.wasm$/);
      expect(shipped, `${key} → ${config.wasmFile}`).toContain(config.wasmFile);
    }
  });

  it('declares a language for every shipped grammar', () => {
    const declared = new Set(Object.values(LANGUAGE_CONFIGS).map((c) => c.wasmFile));
    expect(shipped.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('maps every extension it claims to exactly one language', () => {
    const owner = new Map<string, string>();
    for (const [key, config] of Object.entries(LANGUAGE_CONFIGS)) {
      for (const ext of config.extensions) {
        expect(owner.has(ext), `${ext} claimed by ${owner.get(ext)} and ${key}`).toBe(false);
        owner.set(ext, key);
      }
    }
  });
});
