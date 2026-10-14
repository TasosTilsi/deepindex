import { basename } from 'node:path';

/**
 * In-tree class map for Java (issue #5).
 *
 * A Java source names its own importable FQN: the `package` declaration plus the file
 * stem (a public top-level type must live in a file of the same name). Building the map
 * from file content therefore needs no `pom.xml` parsing, and multi-module repositories
 * work by construction — every module's sources are walked, so module B's
 * `import com.a.A` finds module A's file.
 *
 * The map NEVER classifies. A miss means "not in this repository"; whether that is an
 * external dependency or a broken import is the caller's decision (see resolveImport).
 */
export interface JavaClassIndex {
  readonly byFqn: ReadonlyMap<string, string>;
  readonly byPackage: ReadonlyMap<string, readonly string[]>;
}

// Exactly one package declaration is legal in a Java source and it must be the first
// statement, so one regex is a complete parse of it. The lookahead skips a line that is
// really inside a comment.
const PACKAGE_DECL_RE =
  /^(?!\s*(\/\/|\/\*|\*))[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;/m;

/** The importable FQN of a Java source, derived from its content and file name. */
export function javaFqnFor(relPath: string, content: string): string {
  const stem = basename(relPath).replace(/\.java$/i, '');
  const match = PACKAGE_DECL_RE.exec(content);
  return match?.[2] ? `${match[2]}.${stem}` : stem;
}

/**
 * Builds the map. `entries` MUST be sorted by relPath: the file walk pushes directories
 * on a LIFO stack, so without sorting the "first wins" rule for a duplicate FQN would
 * depend on readdir order.
 */
export function buildJavaClassIndex(
  entries: ReadonlyArray<{ fqn: string; relPath: string }>
): JavaClassIndex {
  const byFqn = new Map<string, string>();
  const byPackage = new Map<string, string[]>();
  for (const { fqn, relPath } of entries) {
    if (!byFqn.has(fqn)) byFqn.set(fqn, relPath);
    const cut = fqn.lastIndexOf('.');
    const pkg = cut > 0 ? fqn.slice(0, cut) : '';
    const bucket = byPackage.get(pkg);
    if (bucket) bucket.push(relPath);
    else byPackage.set(pkg, [relPath]);
  }
  // A wildcard import resolves to the first in-tree class of the package, so that
  // choice has to be stable.
  for (const bucket of byPackage.values()) bucket.sort();
  return { byFqn, byPackage };
}

/** Looks an import up in the in-tree map. A miss returns null and is NOT a verdict. */
export function javaResolve(
  index: JavaClassIndex,
  source: string,
  isStatic: boolean
): string | null {
  const wildcard = source.endsWith('.*');
  const base = wildcard ? source.slice(0, -2) : source;

  if (wildcard) {
    // `import a.b.*;` is package-scoped; `import static a.b.C.*;` is type-scoped.
    const fromPackage = index.byPackage.get(base)?.[0];
    if (fromPackage) return fromPackage;
    return isStatic ? index.byFqn.get(base) ?? null : null;
  }

  const direct = index.byFqn.get(base);
  if (direct) return direct;
  // `import static a.b.C.member;` — the last segment is a member, not a type. Only for
  // static imports: stripping it in general would let `import a.b.C;` match an in-tree
  // class whose FQN is `a.b`.
  if (isStatic) {
    const cut = base.lastIndexOf('.');
    if (cut > 0) return index.byFqn.get(base.slice(0, cut)) ?? null;
  }
  return null;
}
