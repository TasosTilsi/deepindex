// Project registry — records indexed projects so the dashboard can show all
// of them. Stored at ~/.deepindex/projects.json (user-level, all projects).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

export interface ProjectEntry {
  name: string;
  path: string;
  dbPath: string;
  lastIndexed: string;
}

export interface Registry {
  projects: ProjectEntry[];
}

/** Default registry path: ~/.deepindex/projects.json */
export function defaultRegistryPath(): string {
  return join(homedir(), '.deepindex', 'projects.json');
}

/** Load the registry (empty if missing/corrupt). */
export function loadRegistry(registryPath = defaultRegistryPath()): Registry {
  if (!existsSync(registryPath)) return { projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as Registry;
    if (!Array.isArray(parsed.projects)) return { projects: [] };
    return parsed;
  } catch {
    return { projects: [] };
  }
}

/** Save the registry. */
export function saveRegistry(registry: Registry, registryPath = defaultRegistryPath()): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

/** Register (upsert by path) a project. Returns the updated entry. */
export function registerProject(
  entry: { name: string; path: string; dbPath: string },
  registryPath = defaultRegistryPath()
): ProjectEntry {
  const registry = loadRegistry(registryPath);
  const now = new Date().toISOString();
  const existing = registry.projects.find((p) => p.path === entry.path);
  if (existing) {
    existing.name = entry.name;
    existing.dbPath = entry.dbPath;
    existing.lastIndexed = now;
  } else {
    registry.projects.push({ ...entry, lastIndexed: now });
  }
  saveRegistry(registry, registryPath);
  return registry.projects.find((p) => p.path === entry.path)!;
}

/** List all registered projects. */
export function listProjects(registryPath = defaultRegistryPath()): ProjectEntry[] {
  return loadRegistry(registryPath).projects;
}

/** Get a project by name or path. */
export function getProject(
  key: string,
  registryPath = defaultRegistryPath()
): ProjectEntry | undefined {
  return loadRegistry(registryPath).projects.find((p) => p.name === key || p.path === key);
}

/** Discover projects by scanning for `.deepindex.db` files in a root dir and
 *  its immediate subdirectories. This lets the dashboard show projects even
 *  when the home registry is empty/unwritable. */
export function discoverProjects(rootDir: string, depth = 2): ProjectEntry[] {
  const out: ProjectEntry[] = [];
  const seen = new Set<string>();
  const scan = (dir: string, d: number) => {
    if (d > depth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
        scan(full, d + 1);
      } else if (name === '.deepindex.db') {
        const path = dir;
        if (seen.has(path)) continue;
        seen.add(path);
        out.push({ name: basename(path), path, dbPath: full, lastIndexed: '' });
      }
    }
  };
  scan(rootDir, 0);
  return out;
}
