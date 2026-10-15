import { basename } from 'node:path';

/**
 * In-tree class map for the package-based languages: Java (issue #5), and Kotlin and Scala
 * (issue #20), which spell imports the same way.
 *
 * A source names its own importable FQN: the `package` declaration plus the file
 * stem (a public top-level type must live in a file of the same name). Building the map
 * from file content therefore needs no `pom.xml` parsing, and multi-module repositories
 * work by construction — every module's sources are walked, so module B's
 * `import com.a.A` finds module A's file.
 *
 * The map NEVER classifies. A miss means "not in this repository"; whether that is an
 * external dependency or a broken import is the caller's decision (see resolveImport).
 */
const PACKAGE_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin', 'scala', 'c_sharp']);

/**
 * The keyword that introduces a package declaration, per language. C# says `namespace` where the
 * other three say `package`; that one word is the whole difference in how their FQNs are read.
 */
const PACKAGE_KEYWORDS: Record<string, string> = {
  java: 'package',
  kotlin: 'package',
  scala: 'package',
  c_sharp: 'namespace',
};

/** True when a language's imports are package paths resolved through the map below. */
export function isPackageLanguage(language: string | undefined): boolean {
  return language !== undefined && PACKAGE_LANGUAGES.has(language);
}

export interface PackageIndex {
  readonly byFqn: ReadonlyMap<string, string>;
  readonly byPackage: ReadonlyMap<string, readonly string[]>;
  /**
   * Every namespace prefix the tree knows, so a miss can be judged in constant time. An import of
   * `App.Gone` is inside the project when `App` is a prefix of something here — the leaf namespace
   * alone is not enough, because a project need not declare its parent namespaces in a file of
   * their own.
   */
  readonly prefixes: ReadonlySet<string>;
}

// Exactly one package declaration is legal in a Java source and it must be the first statement,
// so a line-anchored search is a complete parse of it. Comments are removed first: a lookahead
// that tried to recognise them in place did not hold, and a commented-out `package` line was
// taken as the real one.
const PACKAGE_DECL_RE =
  /^[ \t]*package[ \t]+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*;?/m;

/** Blank out Java comments so the package search cannot match inside one. */
function stripJavaComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, '');
}

/** The importable FQN of a Java source, derived from its content and file name. */
export function fqnForSource(relPath: string, content: string, language = 'java'): string {
  // Any extension: the map serves Java, Kotlin and Scala, and only Java files end in .java.
  const stem = basename(relPath).replace(/\.[^.]+$/, '');
  const keyword = PACKAGE_KEYWORDS[language] ?? 'package';
  const declaration =
    keyword === 'package'
      ? PACKAGE_DECL_RE
      : new RegExp(`^[ \\t]*${keyword}[ \\t]+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)`, 'm');
  const match = declaration.exec(stripJavaComments(content));
  // Group 1: the package is the regex`s only capturing group now that the comment lookahead is
  // gone (it used to be group 2, which the accessor still read — hence stem-only FQNs and a
  // class map that could not resolve anything).
  return match?.[1] ? `${match[1]}.${stem}` : stem;
}

/**
 * Builds the map. `entries` MUST be sorted by relPath: the file walk pushes directories
 * on a LIFO stack, so without sorting the "first wins" rule for a duplicate FQN would
 * depend on readdir order.
 */
export function buildPackageIndex(
  entries: ReadonlyArray<{ fqn: string; relPath: string }>
): PackageIndex {
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

  const prefixes = new Set<string>();
  for (const name of [...byFqn.keys(), ...byPackage.keys()]) {
    const segments = name.split('.');
    for (let cut = 1; cut < segments.length; cut += 1) {
      prefixes.add(segments.slice(0, cut).join('.'));
    }
  }
  return { byFqn, byPackage, prefixes };
}

/**
 * True when the specifier points INTO this repository but names something that is not here: a
 * class renamed or deleted inside a package the tree knows, or a member of an in-tree class that
 * no longer exists.
 *
 * Such a miss is a broken import, not a dependency. Without this, every non-relative Java
 * specifier was classified external, so a dangling reference was invisible in a dimension worth
 * 0.3 — the class map resolved what it could and silently shrugged at the rest.
 */
export function missesInPackageTree(index: PackageIndex, source: string): boolean {
  const base = source.endsWith('.*') ? source.slice(0, -2) : source;
  const segments = base.split('.');
  // Walk the prefixes from the longest down: if any of them is a type or a package we know, the
  // name we failed to find belongs inside the repository.
  for (let cut = segments.length - 1; cut > 0; cut -= 1) {
    const prefix = segments.slice(0, cut).join('.');
    if (index.byFqn.has(prefix) || index.byPackage.has(prefix) || index.prefixes.has(prefix)) {
      return true;
    }
  }
  return false;
}

/** Looks an import up in the in-tree map. A miss returns null and is NOT a verdict. */
export function resolvePackagePath(
  index: PackageIndex,
  source: string,
  isStatic: boolean
): string | null {
  const wildcard = source.endsWith('.*');
  const base = wildcard ? source.slice(0, -2) : source;

  if (wildcard) {
    // `import a.b.*;` is package-scoped; `import static a.b.C.*;` is type-scoped. Asking the
    // package first meant a static wildcard landed on a *nested package* that shares the type's
    // name (com.a.Bar → the package com.a.Bar) instead of on the type itself.
    if (isStatic) {
      const fromType = index.byFqn.get(base);
      if (fromType) return fromType;
    }
    const fromPackage = index.byPackage.get(base)?.[0];
    if (fromPackage) return fromPackage;
    return isStatic ? index.byFqn.get(base) ?? null : null;
  }

  const direct = index.byFqn.get(base);
  if (direct) return direct;
  // A path that names a PACKAGE rather than a type: Scala's `import a.b.{C, D}` reads down to `a.b`,
  // which is the module that exists on disk. Java and Kotlin never write a bare package import, so
  // this changes nothing for them.
  const packageHit = index.byPackage.get(base)?.[0];
  if (packageHit) return packageHit;
  // `import static a.b.C.member;` — the last segment is a member, not a type. Only for
  // static imports: stripping it in general would let `import a.b.C;` match an in-tree
  // class whose FQN is `a.b`.
  if (isStatic) {
    const cut = base.lastIndexOf('.');
    if (cut > 0) return index.byFqn.get(base.slice(0, cut)) ?? null;
  }
  return null;
}
