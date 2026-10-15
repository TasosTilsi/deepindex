import type { Requirement } from './sync.js';

/**
 * Adapters for external trackers (issue #7).
 *
 * v1 is OFFLINE on purpose. The issue proposed a live Jira/GitHub pull, and two of its
 * premises did not hold here: there is no `last_seen` cursor on `requirements`, and
 * `extractAtomicStatements` splits on newlines only, so a rendered HTML description would
 * have produced one modal statement full of tags. A networked pull would also have
 * brought credential handling (the proposed `--api-token` flag puts the secret in argv),
 * pagination, retries, rate limits, and a surface CI cannot exercise — all before the
 * adapter it needs even existed.
 *
 * So: ingest an export file through a pure normaliser, and use the existing sync path.
 * The adapter is exactly what a future pull would call, so nothing here is thrown away.
 */
export type RequirementFormat = 'jira' | 'github' | 'deepindex';

export interface NormalizeReport {
  requirements: Requirement[];
  /** Non-fatal mapping problems, one line each. */
  warnings: string[];
  /** Entries deliberately dropped (GitHub pull requests, unlabelled issues). */
  skipped: number;
}

const STATUS_MAP: ReadonlyArray<readonly [RegExp, Requirement['status']]> = [
  [/^(done|closed|resolved|completed?|released|fixed)$/i, 'implemented'],
  [/^(in progress|in review|in development|in qa|review|approved|ready)$/i, 'approved'],
  [/^(to do|todo|open|backlog|new|triage|draft)$/i, 'draft'],
];

/** External workflow state -> our three states. Never throws: an unmapped state must not
 *  abort a two-hundred-issue import, it is recorded as draft with a warning. */
export function mapExternalStatus(raw: string): {
  status: Requirement['status'];
  warning?: string;
} {
  const value = (raw ?? '').trim();
  for (const [pattern, status] of STATUS_MAP) {
    if (pattern.test(value)) return { status };
  }
  return { status: 'draft', warning: `unmapped status "${value}" — recorded as draft` };
}

/**
 * Renders tracker HTML (and the subset of ADF that arrives as HTML) down to text.
 * Entities are decoded AFTER tags are stripped, so a literal "&lt;" can never turn into a
 * tag. List items become "- " bullets, which is what extractAtomicStatements keys on.
 */
export function htmlToText(html: string): string {
  return (html ?? '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface JiraIssue {
  key?: string;
  self?: string;
  fields?: { summary?: string; description?: string; status?: { name?: string } };
}

interface GithubIssue {
  number?: number;
  title?: string;
  body?: string;
  html_url?: string;
  state?: string;
  labels?: Array<string | { name?: string }>;
  pull_request?: unknown;
}

/**
 * Maps a tracker export into the requirement shape. Pure: no I/O, no network, so it is
 * fully testable and a future HTTP client only has to hand it the parsed payload.
 */
export function normalizeRequirements(
  format: RequirementFormat,
  raw: unknown
): NormalizeReport {
  const warnings: string[] = [];
  const requirements: Requirement[] = [];
  let skipped = 0;

  if (format === 'deepindex') {
    // The canonical shape goes straight through: upsertRequirements is the single write path and
    // validates it there, so parsing here would only validate it twice.
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) requirements.push(item as Requirement);
    return { requirements, warnings, skipped };
  }

  if (format === 'jira') {
    const issues = Array.isArray(raw) ? raw : (raw as { issues?: unknown })?.issues;
    if (!Array.isArray(issues)) {
      throw new TypeError('jira export: expected an array of issues, or { issues: [...] }');
    }
    for (const issue of issues as JiraIssue[]) {
      const id = issue?.key ? String(issue.key) : '';
      if (!id) {
        skipped += 1;
        continue;
      }
      const mapped = mapExternalStatus(issue.fields?.status?.name ?? '');
      if (mapped.warning) warnings.push(`${id}: ${mapped.warning}`);
      requirements.push({
        id,
        title: issue.fields?.summary ?? '',
        description: htmlToText(issue.fields?.description ?? ''),
        source: issue.self ?? '',
        status: mapped.status,
      });
    }
    return { requirements, warnings, skipped };
  }

  if (!Array.isArray(raw)) throw new TypeError('github export: expected an array of issues');
  for (const issue of raw as GithubIssue[]) {
    if (issue?.pull_request) {
      skipped += 1;
      continue;
    }
    const labels = (issue?.labels ?? []).map((label) =>
      typeof label === 'string' ? label : label?.name ?? ''
    );
    if (!labels.includes('requirement')) {
      skipped += 1;
      continue;
    }
    const status: Requirement['status'] =
      issue.state === 'closed'
        ? 'implemented'
        : labels.some((label) => /^(approved|in-review|in-progress)$/i.test(label))
          ? 'approved'
          : 'draft';
    requirements.push({
      id: `GH-${issue.number}`,
      title: issue.title ?? '',
      description: htmlToText(issue.body ?? ''),
      source: issue.html_url ?? '',
      status,
    });
  }
  return { requirements, warnings, skipped };
}
