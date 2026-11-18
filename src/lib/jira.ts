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
import { extractTextFromAdf, type AdfDoc } from './adf';
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
  /**
   * Replace an issue's description with the given ADF document
   * (phase-2a Improve → Apply). The only description write in the app.
   */
  updateDescription(issueKey: string, description: AdfDoc): Promise<void>;
  /**
   * Post a comment (ADF body) on an issue. Used by Apply to leave the
   * "improved with ReadySet — readiness X → Y" audit trail.
   */
  addComment(issueKey: string, body: AdfDoc): Promise<void>;
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

/**
 * The standard fields scoring reads — exactly the list the production
 * adapter requests from Jira (`forge-jira.ts` builds its request from
 * this constant, so the request and the completeness contract below
 * cannot drift apart).
 */
export const SCORING_FIELD_KEYS = [
  'summary',
  'description',
  'priority',
  'assignee',
  'labels',
  'components',
  'issuelinks',
  'parent',
  'duedate',
  // Both estimate fields: `timeoriginalestimate` is the original
  // estimate, `timeestimate` the remaining one (cross-review A6).
  'timeoriginalestimate',
  'timeestimate',
  'status',
  'project',
  'updated',
] as const;

/**
 * The scoring fields ABSENT from a raw payload, under the site's
 * field map (the mapped story-points / epic-link / acceptance-
 * criteria ids are reported too). Diagnostic: this is the full list
 * of what scoring reads but the payload does not carry, and it is
 * what refusal log lines print.
 *
 * Presence — not non-nullness — is the test. When Jira is asked for
 * a field it answers with the key present and the value null/empty
 * for an unset field; a payload that OMITS the key is not carrying
 * the field at all.
 */
export function missingScoringFields(
  raw: RawJiraIssue,
  fieldMap: JiraFieldMap = DEFAULT_FIELD_MAP,
): string[] {
  const fields = (raw?.fields ?? {}) as Record<string, unknown>;
  const required: string[] = [...SCORING_FIELD_KEYS, fieldMap.storyPoints, fieldMap.epicLink];
  if (fieldMap.acceptanceCriteria) required.push(fieldMap.acceptanceCriteria);
  return required.filter((key) => fields[key] === undefined);
}

/**
 * The scoring gate every entry point applies before scoring a raw
 * payload: all STANDARD scoring fields present.
 *
 * Why custom fields do not gate: their absence is not evidence of a
 * partial payload. In an event, an INCLUDED `customFields` map is
 * authoritative for custom-field state (cross-review B5) — a mapped
 * field absent from it is unset, not unknown. In a REST/search
 * payload, Jira omits a custom field that is outside the issue's
 * field context. Either way `normalizeIssue` reads an absent custom
 * key exactly like null, and no refetch could return a different
 * value. Standard fields are the opposite: Jira returns every one
 * of them when asked, so an absent standard field proves the
 * payload is a skeleton — and a refetch provably returns more.
 *
 * The distinction is load-bearing: Forge issue events for a
 * single-field edit deliver a sparse `issue.fields` (headline
 * fields only) with `customFieldsStatus: 'INCLUDED'`, and scoring
 * that skeleton minted a corrupt 35 for a 100-point issue live on
 * 2026-11-17 (the RS-2 incident — see events.ts). A payload that
 * fails this gate must be re-fetched in full before scoring, never
 * scored as-is.
 */
export function isScoreablePayload(raw: RawJiraIssue): boolean {
  const fields = (raw?.fields ?? {}) as Record<string, unknown>;
  return SCORING_FIELD_KEYS.every((key) => fields[key] !== undefined);
}

/** The refusal every scoring entry point throws on partial data. */
export function incompleteScoringPayloadError(issueKey: string, missing: string[]): Error {
  return new Error(
    `ReadySet: incomplete issue payload for ${issueKey} — missing scoring fields: ${missing.join(', ')}. Refusing to score partial data.`,
  );
}

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
  readonly updateDescriptionCalls: Array<{ issueKey: string; description: AdfDoc }> = [];
  readonly addCommentCalls: Array<{ issueKey: string; body: AdfDoc }> = [];
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

  async updateDescription(issueKey: string, description: AdfDoc): Promise<void> {
    this.updateDescriptionCalls.push({ issueKey, description: structuredClone(description) });
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue) throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    // Mutate the held payload so a later getIssue returns the new
    // description — the Apply flow rescores from exactly that re-read.
    issue.fields.description = structuredClone(description);
  }

  async addComment(issueKey: string, body: AdfDoc): Promise<void> {
    this.addCommentCalls.push({ issueKey, body: structuredClone(body) });
    if (!this.issues.some((candidate) => candidate.key === issueKey)) {
      throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    }
  }
}
