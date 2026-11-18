/**
 * Jira access layer.
 *
 * Everything that knows the Jira REST payload shape lives here. The rest
 * of the app talks to the {@link JiraAdapter} interface and consumes
 * {@link NormalizedIssue}s, so tests can substitute {@link FakeJiraAdapter}
 * and the rubric never sees a raw payload.
 *
 * The production adapter (`forge-jira.ts`) is the only file that calls
 * `requestJira`.
 */
import { extractTextFromAdf } from './adf';
import type { NormalizedIssue } from './types';

/** Subset of the Jira REST v3 issue payload that ReadySet reads. */
export interface RawJiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    issuelinks?: Array<unknown>;
    parent?: { key?: string } | null;
    duedate?: string | null;
    timeestimate?: number | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { key?: string };
    updated?: string;
    [customField: string]: unknown;
  };
}

export interface SearchPage {
  issues: RawJiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

export interface JiraAdapter {
  getIssue(issueKey: string): Promise<RawJiraIssue>;
  searchIssues(jql: string, startAt: number, maxResults: number): Promise<SearchPage>;
}

/**
 * Custom field ids differ per Jira site. These are the near-universal
 * defaults (story points + classic epic link); a site mapping can be
 * supplied without touching the normalizer.
 */
export interface JiraFieldMap {
  storyPoints: string;
  epicLink: string;
  /** Dedicated acceptance-criteria field, when the site has one. */
  acceptanceCriteria: string | null;
}

export const DEFAULT_FIELD_MAP: JiraFieldMap = {
  storyPoints: 'customfield_10016',
  epicLink: 'customfield_10014',
  acceptanceCriteria: null,
};

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asEpicKey(value: unknown): string | null {
  // Classic epic link is a bare issue key string; some sites return an object.
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object' && 'key' in value) {
    const key = (value as { key?: unknown }).key;
    return typeof key === 'string' && key.length > 0 ? key : null;
  }
  return null;
}

export function normalizeIssue(
  raw: RawJiraIssue,
  fieldMap: JiraFieldMap = DEFAULT_FIELD_MAP,
): NormalizedIssue {
  const fields = raw.fields ?? {};
  const acceptanceRaw =
    fieldMap.acceptanceCriteria !== null ? fields[fieldMap.acceptanceCriteria] : null;
  return {
    key: raw.key,
    projectKey: fields.project?.key ?? raw.key.split('-')[0] ?? '',
    summary: fields.summary ?? '',
    descriptionText: extractTextFromAdf(fields.description),
    acceptanceCriteriaText:
      acceptanceRaw === null || acceptanceRaw === undefined
        ? null
        : extractTextFromAdf(acceptanceRaw),
    storyPoints: asNumber(fields[fieldMap.storyPoints]),
    originalEstimateSeconds: asNumber(fields.timeestimate),
    priority: fields.priority?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    labels: fields.labels ?? [],
    components: (fields.components ?? [])
      .map((component) => component.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
    linkedIssueCount: (fields.issuelinks ?? []).length,
    parentKey: fields.parent?.key ?? null,
    epicKey: asEpicKey(fields[fieldMap.epicLink]),
    dueDate: fields.duedate ?? null,
    statusName: fields.status?.name ?? '',
    statusCategory: fields.status?.statusCategory?.key ?? '',
    updated: fields.updated ?? '',
  };
}

/** Open issues of a project, in stable key order for checkpointed scans. */
export function projectScanJql(projectKey: string): string {
  return `project = "${projectKey}" AND statusCategory != Done ORDER BY key ASC`;
}

/**
 * In-memory JiraAdapter for tests. searchIssues understands exactly the
 * JQL shape {@link projectScanJql} produces (project key + open-only);
 * anything else returns everything it holds. That narrowness is
 * deliberate: the fake models the queries the app actually issues.
 */
export class FakeJiraAdapter implements JiraAdapter {
  readonly getIssueCalls: string[] = [];
  readonly searchCalls: Array<{ jql: string; startAt: number; maxResults: number }> = [];

  constructor(private readonly issues: RawJiraIssue[]) {}

  async getIssue(issueKey: string): Promise<RawJiraIssue> {
    this.getIssueCalls.push(issueKey);
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue) throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    return structuredClone(issue);
  }

  async searchIssues(jql: string, startAt: number, maxResults: number): Promise<SearchPage> {
    this.searchCalls.push({ jql, startAt, maxResults });
    const projectMatch = jql.match(/project\s*=\s*"([^"]+)"/);
    let pool = this.issues;
    if (projectMatch) {
      pool = pool.filter((issue) => issue.fields.project?.key === projectMatch[1]);
    }
    if (jql.includes('statusCategory != Done')) {
      pool = pool.filter((issue) => issue.fields.status?.statusCategory?.key !== 'done');
    }
    const sorted = [...pool].sort((a, b) => a.key.localeCompare(b.key));
    return {
      issues: structuredClone(sorted.slice(startAt, startAt + maxResults)),
      total: sorted.length,
      startAt,
      maxResults,
    };
  }
}
