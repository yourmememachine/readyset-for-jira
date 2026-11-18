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
    /** Remaining estimate (seconds) — NOT the original estimate (A6). */
    timeestimate?: number | null;
    /** Original estimate (seconds). */
    timeoriginalestimate?: number | null;
    status?: { name?: string; statusCategory?: { key?: string } };
    project?: { key?: string };
    updated?: string;
    [customField: string]: unknown;
  };
}

/**
 * One page of JQL search results from `POST /rest/api/3/search/jql`.
 * The legacy `/rest/api/3/search` endpoint was removed from Jira Cloud
 * (HTTP 410, CHANGE-2046); the replacement paginates with an opaque
 * `nextPageToken` — there is no `total` and no offset, pages are not
 * guaranteed full, and iteration ends when `isLast` is true
 * (cross-review B1).
 */
export interface SearchPage {
  issues: RawJiraIssue[];
  isLast: boolean;
  nextPageToken?: string;
}

/** One entry of `GET /rest/api/3/field` (cross-review B8). */
export interface JiraFieldInfo {
  id: string;
  name: string;
  custom: boolean;
}

/**
 * Thrown by adapters when Jira rejects a pagination token (expired or
 * rotated). Scan code restarts the scan on this error only — any other
 * failure checkpoints and surfaces, so a persistent error can never
 * turn into a restart loop (cross-review A-NEW-2).
 */
export class InvalidPageTokenError extends Error {
  constructor(token: string) {
    super(`Invalid or expired page token: ${token}`);
    this.name = 'InvalidPageTokenError';
  }
}

export interface JiraAdapter {
  getIssue(issueKey: string, fieldMap?: JiraFieldMap): Promise<RawJiraIssue>;
  searchIssues(
    jql: string,
    pageToken: string | null,
    maxResults: number,
    fieldMap?: JiraFieldMap,
  ): Promise<SearchPage>;
  /** All fields visible on the site, for runtime field-map resolution. */
  listFields(): Promise<JiraFieldInfo[]>;
  /**
   * Whether the *current user* holds a project permission (checked via
   * `asUser`). Used to gate project settings (cross-review B13).
   */
  hasProjectPermission(projectKey: string, permission: string): Promise<boolean>;
}

/**
 * Resolve the site-specific field map from the site's field list by
 * matching field *names* (cross-review B8). Falls back to the default
 * ids for anything the site doesn't expose under a known name, so a
 * site that hides its field list degrades to the previous behaviour
 * instead of breaking.
 */
export function resolveFieldMap(fields: JiraFieldInfo[]): JiraFieldMap {
  const byName = new Map(fields.map((field) => [field.name.trim().toLowerCase(), field.id]));
  const pick = (names: string[], fallback: string | null): string | null => {
    for (const name of names) {
      const id = byName.get(name);
      if (id) return id;
    }
    return fallback;
  };
  return {
    storyPoints:
      pick(['story points', 'story point estimate'], DEFAULT_FIELD_MAP.storyPoints) ??
      DEFAULT_FIELD_MAP.storyPoints,
    epicLink: pick(['epic link'], DEFAULT_FIELD_MAP.epicLink) ?? DEFAULT_FIELD_MAP.epicLink,
    acceptanceCriteria: pick(['acceptance criteria'], DEFAULT_FIELD_MAP.acceptanceCriteria),
  };
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
    // `timeestimate` is the REMAINING estimate; the original estimate
    // is `timeoriginalestimate`. Prefer the original and fall back to
    // remaining (a positive remaining is itself evidence an estimate
    // was set) — otherwise a fully-logged issue fails the estimate
    // check precisely because work was logged (cross-review A6).
    originalEstimateSeconds:
      asNumber(fields.timeoriginalestimate) ?? asNumber(fields.timeestimate),
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

const FAKE_TOKEN_PREFIX = 'pg:';

function encodeFakeToken(offset: number): string {
  return `${FAKE_TOKEN_PREFIX}${offset}`;
}

function decodeFakeToken(token: string | null): number {
  if (token === null) return 0;
  if (!token.startsWith(FAKE_TOKEN_PREFIX)) {
    throw new InvalidPageTokenError(token);
  }
  const offset = Number(token.slice(FAKE_TOKEN_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new InvalidPageTokenError(token);
  }
  return offset;
}

const DEFAULT_FAKE_FIELDS: JiraFieldInfo[] = [
  { id: 'customfield_10016', name: 'Story Points', custom: true },
  { id: 'customfield_10014', name: 'Epic Link', custom: true },
  { id: 'summary', name: 'Summary', custom: false },
  { id: 'description', name: 'Description', custom: false },
];

/**
 * In-memory JiraAdapter for tests. searchIssues understands exactly the
 * JQL shape {@link projectScanJql} produces (project key + open-only);
 * anything else returns everything it holds. That narrowness is
 * deliberate: the fake models the queries the app actually issues.
 *
 * Pagination models the real `/search/jql` contract (cross-review B1):
 * opaque tokens (here `pg:{offset}` — the encoding is the fake's own
 * business), `isLast` termination, and an error for a malformed token,
 * mirroring Jira's 400 on a bad `nextPageToken`.
 */
export class FakeJiraAdapter implements JiraAdapter {
  readonly getIssueCalls: string[] = [];
  readonly searchCalls: Array<{ jql: string; pageToken: string | null; maxResults: number }> = [];
  readonly listFieldsCalls: number[] = [];
  /** Projects the "current user" administers; empty = all projects. */
  adminProjects: ReadonlySet<string> | null = null;

  constructor(
    private readonly issues: RawJiraIssue[],
    private readonly fields: JiraFieldInfo[] = DEFAULT_FAKE_FIELDS,
  ) {}

  async getIssue(issueKey: string): Promise<RawJiraIssue> {
    this.getIssueCalls.push(issueKey);
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue) throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    return structuredClone(issue);
  }

  async searchIssues(
    jql: string,
    pageToken: string | null,
    maxResults: number,
  ): Promise<SearchPage> {
    this.searchCalls.push({ jql, pageToken, maxResults });
    const startAt = decodeFakeToken(pageToken);
    const projectMatch = jql.match(/project\s*=\s*"([^"]+)"/);
    let pool = this.issues;
    if (projectMatch) {
      pool = pool.filter((issue) => issue.fields.project?.key === projectMatch[1]);
    }
    if (jql.includes('statusCategory != Done')) {
      pool = pool.filter((issue) => issue.fields.status?.statusCategory?.key !== 'done');
    }
    const sorted = [...pool].sort((a, b) => a.key.localeCompare(b.key));
    const pageIssues = sorted.slice(startAt, startAt + maxResults);
    const nextOffset = startAt + pageIssues.length;
    const isLast = nextOffset >= sorted.length;
    return {
      issues: structuredClone(pageIssues),
      isLast,
      ...(isLast ? {} : { nextPageToken: encodeFakeToken(nextOffset) }),
    };
  }

  async listFields(): Promise<JiraFieldInfo[]> {
    this.listFieldsCalls.push(1);
    return structuredClone(this.fields);
  }

  async hasProjectPermission(projectKey: string): Promise<boolean> {
    return this.adminProjects === null || this.adminProjects.has(projectKey);
  }
}
