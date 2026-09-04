import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistry,
  saveRegistry,
  registerProject,
  listProjects,
  getProject,
  discoverProjects,
} from '../src/registry.js';

describe('project registry', () => {
  let dir: string;
  let regPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'deepindex-reg-'));
    regPath = join(dir, 'projects.json');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loadRegistry returns empty for missing file', () => {
    expect(loadRegistry(regPath).projects).toEqual([]);
  });

  it('registerProject upserts by path', () => {
    registerProject({ name: 'a', path: '/x/a', dbPath: '/x/a.db' }, regPath);
    registerProject({ name: 'a2', path: '/x/a', dbPath: '/x/a2.db' }, regPath);
    const projects = listProjects(regPath);
    expect(projects.length).toBe(1);
    expect(projects[0].name).toBe('a2');
    expect(projects[0].dbPath).toBe('/x/a2.db');
  });

  it('registerProject adds distinct projects', () => {
    registerProject({ name: 'b', path: '/x/b', dbPath: '/x/b.db' }, regPath);
    expect(listProjects(regPath).length).toBe(2);
  });

  it('getProject finds by name or path', () => {
    expect(getProject('a2', regPath)?.path).toBe('/x/a');
    expect(getProject('/x/b', regPath)?.name).toBe('b');
    expect(getProject('nope', regPath)).toBeUndefined();
  });

  it('saveRegistry round-trips', () => {
    saveRegistry({ projects: [{ name: 'c', path: '/x/c', dbPath: '/x/c.db', lastIndexed: 'now' }] }, regPath);
    expect(loadRegistry(regPath).projects[0].name).toBe('c');
  });

  it('discoverProjects finds .deepindex.db files in the tree', () => {
    const root = join(dir, 'discover');
    mkdirSync(join(root, 'proj-a'), { recursive: true });
    mkdirSync(join(root, 'proj-b'), { recursive: true });
    writeFileSync(join(root, 'proj-a', '.deepindex.db'), '');
    writeFileSync(join(root, 'proj-b', '.deepindex.db'), '');
    const found = discoverProjects(root);
    const names = found.map((p) => p.name).sort();
    expect(names).toEqual(['proj-a', 'proj-b']);
  });
});
