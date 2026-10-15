import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initDb } from '../src/graph/db.js';
import { buildGraph } from '../src/graph/build.js';

/**
 * Python imports (issue #20).
 *
 * #13 taught Java to say which of its symbols are importable, but every other language still
 * reported `exported = 0` — and, as the measurement in the issue showed, that flag alone changes
 * no edge, because those languages produced **no import rows at all**: the extractor handled only
 * the JS/TS `import_statement` `source` field and Java's `import_declaration`. Python's imports are
 * neither: `import a.b, c.d` carries a `dotted_name` per module, and `from .mod import x` is an
 * `import_from_statement` whose `module_name` field is a `relative_import`.
 *
 * Python's file mapping is also its own: a specifier is a dotted package path (resolved against the
 * import roots, so the repository root and a `src/` layout both count) or a relative one (leading
 * dots climb packages from the importing file).
 */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

async function buildPythonRepo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-python-'));
  writeFiles(dir, files);
  const db = initDb(join(dir, '.db'));
  await buildGraph(db, dir);
  return { db, dir };
}

function importRow(db: ReturnType<typeof initDb>, source: string) {
  const row = db
    .prepare(
      `SELECT i.resolved AS resolved, i.external AS external, t.path AS target
       FROM imports i JOIN files f ON f.id = i.file_id
       LEFT JOIN files t ON t.id = i.resolved_file_id
       WHERE i.source = ?`
    )
    .get(source) as { resolved: number; external: number; target: string | null } | undefined;
  return row;
}

describe('python imports', () => {
  const PKG = {
    'pkg/__init__.py': '',
    'pkg/mod.py': 'def thing():\n    return 1\n',
    'pkg/helpers.py': 'class Helper:\n    pass\n',
  };

  it('extracts and resolves absolute package paths against the repository root', async () => {
    const { db, dir } = await buildPythonRepo({
      ...PKG,
      'main.py': 'from pkg.mod import thing\nfrom pkg import helpers\nimport os\n',
    });
    try {
      expect(importRow(db, 'pkg.mod')).toMatchObject({ resolved: 1, target: 'pkg/mod.py' });
      // `from pkg import helpers` imports the package; the file for it is its __init__.
      expect(importRow(db, 'pkg')).toMatchObject({ resolved: 1, target: 'pkg/__init__.py' });
      // A standard-library module names no file here and stays external.
      expect(importRow(db, 'os')).toMatchObject({ resolved: 1, external: 1 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves a src/ layout as a second import root', async () => {
    const { db, dir } = await buildPythonRepo({
      'src/lib/__init__.py': '',
      'src/lib/util.py': 'class Util:\n    pass\n',
      'src/app/cli.py': 'from lib.util import Util\n',
    });
    try {
      expect(importRow(db, 'lib.util')).toMatchObject({ resolved: 1, target: 'src/lib/util.py' });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('walks leading dots the way Python does: one dot per package, from the module own package', async () => {
    // In app/jobs/run.py the module's package is `app.jobs`, so `.` is app/jobs and `..` is app.
    // (This test's first version expected `..pkg.mod` to reach the repository root and was wrong;
    // the resolver was right, and the expectation was corrected here.)
    const { db, dir } = await buildPythonRepo({
      'app/__init__.py': '',
      'app/jobs/__init__.py': '',
      'app/jobs/sibling.py': 'value = 1\n',
      'app/jobs/run.py': 'from .sibling import value\nfrom ..pkg.mod import thing\nfrom ...outside import z\n',
      'app/pkg/__init__.py': '',
      'app/pkg/mod.py': 'def thing():\n    return 1\n',
    });
    try {
      const rows = db
        .prepare(
          `SELECT i.source AS source, i.resolved AS resolved, i.external AS external, t.path AS target
           FROM imports i JOIN files f ON f.id = i.file_id
           LEFT JOIN files t ON t.id = i.resolved_file_id
           WHERE f.path = 'app/jobs/run.py' ORDER BY i.source`
        )
        .all() as Array<{ source: string; resolved: number; external: number; target: string | null }>;

      expect(rows).toEqual([
        // Three dots climb above the repository root, so there is nothing to link: broken, which
        // is what Python does too (ImportError).
        { source: '....outside'.slice(1), resolved: 0, external: 0, target: null },
        { source: '..pkg.mod', resolved: 1, external: 0, target: 'app/pkg/mod.py' },
        { source: '.sibling', resolved: 1, external: 0, target: 'app/jobs/sibling.py' },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts a missing relative module as broken, and says so once', async () => {
    const { db, dir } = await buildPythonRepo({
      ...PKG,
      'main.py': 'from .missing import gone\n',
    });
    try {
      expect(importRow(db, '.missing')).toMatchObject({ resolved: 0, external: 0, target: null });
      const health = db.prepare('SELECT COUNT(*) AS n FROM imports WHERE resolved = 0').get() as {
        n: number;
      };
      expect(health.n).toBe(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports python symbols as importable, since the language has no visibility keyword', async () => {
    const { db, dir } = await buildPythonRepo({
      ...PKG,
      'main.py': 'from pkg.mod import thing\n',
    });
    try {
      const symbols = db
        .prepare('SELECT name, exported FROM symbols ORDER BY name')
        .all() as { name: string; exported: number }[];
      expect(symbols).toEqual([
        { name: 'Helper', exported: 1 },
        { name: 'thing', exported: 1 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a JS-style specifier out of the python path: `import x as y` names x', async () => {
    const { db, dir } = await buildPythonRepo({
      'pkg/__init__.py': '',
      'pkg/mod.py': 'def thing():\n    return 1\n',
      'main.py': 'import pkg.mod as m\n',
    });
    try {
      // The alias is not part of the module path.
      expect(importRow(db, 'pkg.mod')).toMatchObject({ resolved: 1, target: 'pkg/mod.py' });
      expect(importRow(db, 'pkg.mod as m')).toBeUndefined();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
