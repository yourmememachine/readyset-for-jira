import type { RawJiraIssue } from '../src/lib/jira';
import type { NormalizedIssue } from '../src/lib/types';

/**
 * A description that satisfies the rubric: 280+ characters, contains an
 * acceptance-criteria section, and contains no placeholder markers.
 */
export const LONG_DESCRIPTION = [
  'Merchants integrating with the public API currently have no protection',
  'against bursty client traffic, and a single noisy integration can degrade',
  'latency for everyone on the platform. This work adds token-bucket rate',
  'limiting to the gateway so each API key receives a fair, predictable',
  'quota and the platform stays responsive under load.',
  '',
  'Acceptance criteria:',
  '- Requests beyond the configured quota return HTTP 429 with a Retry-After header.',
  '- Quota is configurable per API key without a deploy.',
  '- Metrics expose rejected-request counts per API key.',
].join('\n');

/** A fully specified issue: every rubric check passes, score 100. */
export function makeIssue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    key: 'RS-1',
    projectKey: 'RS',
    summary: 'Add rate limiting to the public API gateway endpoints',
    descriptionText: LONG_DESCRIPTION,
    acceptanceCriteriaText: null,
    storyPoints: 3,
    originalEstimateSeconds: null,
    priority: 'Medium',
    assignee: 'Ada Lovelace',
    labels: ['backend'],
    components: [],
    linkedIssueCount: 1,
    parentKey: null,
    epicKey: null,
    dueDate: null,
    statusName: 'To Do',
    statusCategory: 'new',
    updated: '2026-11-17T10:00:00.000Z',
    ...overrides,
  };
}

/** An issue with nothing filled in. Only the two vacuous checks pass. */
export function makeEmptyIssue(): NormalizedIssue {
  return makeIssue({
    key: 'RS-99',
    summary: '',
    descriptionText: '',
    storyPoints: null,
    originalEstimateSeconds: null,
    priority: null,
    assignee: null,
    labels: [],
    components: [],
    linkedIssueCount: 0,
    parentKey: null,
    epicKey: null,
    dueDate: null,
  });
}

function adfFromText(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: text
      .split(/\n{2,}/)
      .map((block) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: block.replace(/\n/g, ' ') }],
      })),
  };
}

/** Raw REST-shaped twin of {@link makeIssue}: fully specified, score 100. */
export function makeRawIssue(overrides: Partial<RawJiraIssue['fields']> = {}, key = 'RS-1'): RawJiraIssue {
  return {
    key,
    fields: {
      summary: 'Add rate limiting to the public API gateway endpoints',
      description: adfFromText(LONG_DESCRIPTION),
      priority: { name: 'Medium' },
      assignee: { displayName: 'Ada Lovelace' },
      labels: ['backend'],
      components: [],
      issuelinks: [{ id: '10001' }],
      parent: null,
      duedate: null,
      timeestimate: null,
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      project: { key: 'RS' },
      updated: '2026-11-17T10:00:00.000Z',
      customfield_10016: 3,
      ...overrides,
    },
  };
}

/** Raw issue missing only its estimate: score 90 under default settings. */
export function makeRawIssueNoEstimate(key = 'RS-2'): RawJiraIssue {
  return makeRawIssue({ customfield_10016: null, timeestimate: null }, key);
}

/**
 * Raw messy issue: vague summary, no description, nothing set except a
 * default priority. Scores 20 (priority 5 + no-placeholders 10 +
 * due-date not-applicable 5).
 */
export function makeRawMessyIssue(key = 'RS-3'): RawJiraIssue {
  return makeRawIssue(
    {
      summary: 'Fix bug',
      description: null,
      assignee: null,
      labels: [],
      issuelinks: [],
      customfield_10016: null,
    },
    key,
  );
}
