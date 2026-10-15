import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

/**
 * Release workflow (issue #11).
 *
 * The tag-triggered workflow is the only path from a commit to a published version, and
 * nothing else in the repo exercises it, so a mistake there is silent until a release
 * misreports. Three invariants, each of which the diagnostic scaffolding had broken:
 *
 *   1. the publish step can FAIL the job — it used to end in `true`, so a failed publish
 *      still produced a green run;
 *   2. the registry gate names the version being released, not a literal — `grep -q
 *      '"0.3.4"'` is true forever once 0.3.4 shipped;
 *   3. the job may write contents, or `gh release create` gets a 403 after a good publish.
 */
const WORKFLOW = resolve(process.cwd(), '.github/workflows/release.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
  if?: string;
  uses?: string;
}
interface Workflow {
  jobs?: Record<
    string,
    {
      permissions?: Record<string, string>;
      steps?: WorkflowStep[];
    }
  >;
}

function loadWorkflow(): Workflow {
  return yamlLoad(readFileSync(WORKFLOW, 'utf8')) as Workflow;
}

function publishSteps(): WorkflowStep[] {
  return loadWorkflow().jobs?.publish?.steps ?? [];
}

describe('release workflow', () => {
  it('is valid YAML with a publish job that has steps', () => {
    expect(publishSteps().length).toBeGreaterThan(0);
  });

  it('publishes with a step that cannot be swallowed', () => {
    const publish = publishSteps().filter(
      (s) => typeof s.run === 'string' && s.run.includes('npm publish')
    );
    expect(publish.length).toBeGreaterThan(0);
    for (const step of publish) {
      // `true` (or `|| true`) as the last command makes the job green no matter what
      // npm did — the failure mode this issue is about.
      expect(step.run!.trimEnd().endsWith('true')).toBe(false);
      expect(step.run).not.toMatch(/\|\|\s*true\s*$/m);
    }
  });

  it('keeps the authToken strip that trusted publishing needs', () => {
    const strip = publishSteps().find(
      (s) => typeof s.run === 'string' && s.run.includes('_authToken')
    );
    expect(strip).toBeDefined();
  });
});
