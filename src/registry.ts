// Project registry — records indexed projects so the dashboard can show all
// of them. Stored at ~/.deepindex/projects.json (user-level, all projects).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
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
  mkdirSync(join(registryPath, '..'), { recursive: true });
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
