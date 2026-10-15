import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ImportUsageError,
  loadRequirementsExport,
  renderImport,
} from '../src/requirements/import-verb.js';

/**
 * The `requirements import` verb's logic, called directly (issue #21).
 *
 * The spawn-level suite next door still drives the real CLI end to end, which is the evidence that
 * this move changed nothing. These tests are what the coverage gate can see.
 */
function tempFile(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deepindex-req-verb-'));
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

describe('loadRequirementsExport', () => {
  it('reads the canonical shape', () => {
    const file = tempFile(
      'reqs.json',
      JSON.stringify([{ id: 'WV-1', title: 'Do a thing', status: 'open', source: 'jira' }])
    );
    try {
      const report = loadRequirementsExport(file, 'deepindex');
      expect(report.requirements).toHaveLength(1);
      expect(report.requirements[0].id).toBe('WV-1');
    } finally {
      rmSync(join(file, '..'), { recursive: true, force: true });
    }
  });

  it('normalises a Jira export and a GitHub export', () => {
    // Shapes taken from the normaliser's own fixture next door rather than invented: Jira needs
    // `self` and `description`, and GitHub skips an issue with no requirement label.
    const jira = tempFile(
      'jira.json',
      JSON.stringify({
        issues: [
          {
            key: 'WV-2',
            self: 'https://acme.atlassian.net/rest/api/3/issue/10002',
            fields: {
              summary: 'From Jira',
              description: '<p>The system shall do it.</p>',
              status: { name: 'In Progress' },
            },
          },
        ],
      })
    );
    const github = tempFile(
      'gh.json',
      JSON.stringify([
        {
          number: 7,
          title: 'From GitHub',
          state: 'open',
          html_url: 'https://github.com/x/y/issues/7',
          body: 'The system shall do it.',
          labels: [{ name: 'requirement' }],
        },
      ])
    );
    try {
      expect(loadRequirementsExport(jira, 'jira').requirements[0].id).toBe('WV-2');
      expect(loadRequirementsExport(github, 'github').requirements[0].id).toBe('GH-7');
    } finally {
      rmSync(join(jira, '..'), { recursive: true, force: true });
    }
  });

  it('calls an unknown format and a missing file usage, and a broken file not', () => {
    const broken = tempFile('broken.json', '{not json');
    try {
      expect(() => loadRequirementsExport(broken, 'asana')).toThrow(ImportUsageError);
      expect(() => loadRequirementsExport(broken, 'asana')).toThrow(/invalid --format/);
      expect(() => loadRequirementsExport('/nowhere/at/all.json', 'jira')).toThrow(ImportUsageError);
      expect(() => loadRequirementsExport('/nowhere/at/all.json', 'jira')).toThrow(/file not found/);
      // Unparseable content is a runtime failure, which the CLI exits 1 for.
      expect(() => loadRequirementsExport(broken, 'jira')).not.toThrow(ImportUsageError);
      expect(() => loadRequirementsExport(broken, 'jira')).toThrow(SyntaxError);
    } finally {
      rmSync(join(broken, '..'), { recursive: true, force: true });
    }
  });
});

describe('renderImport', () => {
  const report = { requirements: [{ id: 'a' }, { id: 'b' }], skipped: 3, warnings: ['w'] } as never;

  it('renders the dry run in both shapes', () => {
    expect(renderImport(report, { json: false, dryRun: true })).toBe(
      'Would import 2 requirements (3 skipped).'
    );
    expect(JSON.parse(renderImport(report, { json: true, dryRun: true }))).toEqual({
      imported: 2,
      atomic: 0,
      skipped: 3,
      warnings: ['w'],
    });
  });

  it('renders a written import in both shapes', () => {
    expect(
      renderImport(report, { json: false, dryRun: false, format: 'jira', imported: 2, atomic: 5 })
    ).toBe('Imported 2 requirements (5 atomic statements) from jira export.');
    expect(
      JSON.parse(
        renderImport(report, { json: true, dryRun: false, format: 'jira', imported: 2, atomic: 5 })
      )
    ).toEqual({ imported: 2, atomic: 5, skipped: 3, warnings: ['w'] });
  });
});
