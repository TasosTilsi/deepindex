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
 * `deepindex index` silently skipped every non-ts/js file.
 */
describe('multi-language build (walker-level e2e)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let srcDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-mlang-'));
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

/**
 * DI-02: Java records and enums must be captured as symbols at walker level.
 * Records are the modern-Java domain-type idiom (the upstream A/B demo's
 * `Money` record was invisible to retrieve); enums are the same one-line
 * nodeMap gap in the same language.
 */
describe('java record + enum symbols at walker level (DI-02)', () => {
  let db: Database.Database;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'deepindex-java-rec-'));
    const srcDir = join(tmpDir, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'Money.java'),
      'import java.math.BigDecimal;\n\n' +
        'public record Money(BigDecimal amount, String currency) {\n' +
        '  public Money add(Money other) { return new Money(amount.add(other.amount), currency); }\n' +
        '}\n',
    );
    writeFileSync(
      join(srcDir, 'Status.java'),
      'public enum Status {\n  ACTIVE,\n  CLOSED\n}\n',
    );
    db = initDb(join(tmpDir, 'test.db'));
    await buildGraph(db, tmpDir);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes the record type as a class symbol', () => {
    const rows = db
      .prepare(
        `SELECT s.name, s.kind FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.language = 'java'`,
      )
      .all() as { name: string; kind: string }[];
    expect(rows.some((s) => s.name === 'Money' && s.kind === 'class')).toBe(true);
  });

  it('indexes the enum type as an enum symbol', () => {
    const rows = db
      .prepare(
        `SELECT s.name, s.kind FROM symbols s JOIN files f ON s.file_id = f.id WHERE f.language = 'java'`,
      )
      .all() as { name: string; kind: string }[];
    expect(rows.some((s) => s.name === 'Status' && s.kind === 'enum')).toBe(true);
  });
});