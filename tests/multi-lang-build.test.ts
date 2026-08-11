import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';
import type Database from 'better-sqlite3';

/**
 * End-to-end multi-language indexing: the build WALKER (not just parseFile)
 * must discover and index java/c/go/rust files. Regression guard for SC1 —
 * the multi-lang parser existed but was disconnected from SUPPORTED_EXTS, so
 * `deepinit index` silently skipped every non-ts/js file.
 */
describe('multi-language build (walker-level e2e)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let srcDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ctx-mlang-'));
    srcDir = join(tmpDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(
      join(srcDir, 'MyJava.java'),
      'public class MyJava { public void doThing() {} }\n',
    );
    writeFileSync(
      join(srcDir, 'main.go'),
      'package main\n\ntype MyGo struct{}\nfunc doThing() {}\n',
    );
    writeFileSync(
      join(srcDir, 'lib.rs'),
      'pub struct MyRust {}\npub fn do_thing() {}\n',
    );
    writeFileSync(
      join(srcDir, 'foo.c'),
      'int do_thing(void) { return 0; }\n',
    );

    db = initDb(join(tmpDir, 'test.db'));
    await buildGraph(db, tmpDir);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes all four multi-language files (not just ts/js)', () => {
    const rows = db
      .prepare('SELECT language, COUNT(*) as c FROM files GROUP BY language')
      .all() as { language: string; c: number }[];
    const byLang = new Map(rows.map((r) => [r.language, r.c]));
    expect(byLang.get('java')).toBe(1);
    expect(byLang.get('go')).toBe(1);
    expect(byLang.get('rust')).toBe(1);
    expect(byLang.get('c')).toBe(1);
  });

  it('extracts symbols from each multi-language file', () => {
    const symbols = db
      .prepare(
        `SELECT s.name, s.kind, f.language FROM symbols s
         JOIN files f ON s.file_id = f.id
         WHERE f.language IN ('java','go','rust','c')`,
      )
      .all() as { name: string; kind: string; language: string }[];

    const byLang = new Map<string, { name: string; kind: string }[]>();
    for (const s of symbols) {
      if (!byLang.has(s.language)) byLang.set(s.language, []);
      byLang.get(s.language)!.push({ name: s.name, kind: s.kind });
    }

    // Each of the four languages must contribute at least one symbol —
    // proves the walker routes multi-lang files through parseFile.
    expect(byLang.has('java')).toBe(true);
    expect(byLang.has('go')).toBe(true);
    expect(byLang.has('rust')).toBe(true);
    expect(byLang.has('c')).toBe(true);

    // Known-good per-language symbols (verified against parseFile output).
    expect(symbols.some((s) => s.language === 'java' && s.name === 'MyJava' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.language === 'rust' && s.name === 'MyRust' && s.kind === 'class')).toBe(true);
    expect(symbols.some((s) => s.language === 'go' && s.name === 'doThing' && s.kind === 'method')).toBe(true);
    expect(symbols.some((s) => s.language === 'c' && s.name === 'do_thing' && s.kind === 'method')).toBe(true);
  });
});