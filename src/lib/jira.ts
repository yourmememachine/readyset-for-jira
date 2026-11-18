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
    issuetype?: { name?: string } | null;
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
  /** `schema.type` from the field list, when the adapter carries it (round 2, F-7). */
  schemaType?: string;
  /** `schema.custom` (the field-type plugin key), when carried. */
  schemaCustom?: string;
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
   * Replace an issue's summary (Wave 3 summary Improve). Runs as the
   * app, like the description write.
   */
  updateSummary(issueKey: string, summary: string): Promise<void>;
  /**
   * Assign the issue to the *current user* (Wave 3 Improve & Assign).
   * Checked and performed as the user: the assignee is whoever clicked
   * Apply, never the app.
   */
  assignToUser(issueKey: string, accountId: string): Promise<void>;
  /**
   * Post a comment (ADF body) on an issue. Used by Apply to leave the
   * "improved with ReadySet — readiness X → Y" audit trail.
   */
  addComment(issueKey: string, body: AdfDoc): Promise<void>;
  /**
   * Write the issue's `readyset` entity property ({ score, grade,
   * updatedAt }) so the score is searchable from JQL, boards and
   * filters via the manifest's entity-property extractions
   * (upgrade pack, review #2). Best-effort by contract: callers log
   * and swallow failures — a property write must never fail scoring.
   */
  setScoreProperty(issueKey: string, value: { score: number; grade: string; updatedAt: string }): Promise<void>;
  deleteScoreProperty(issueKey: string): Promise<void>;
}

/**
 * Resolve the site-specific field map from the site's field list by
 * matching field *names* (cross-review B8). Falls back to the default
 * ids for anything the site doesn't expose under a known name, so a
 * site that hides its field list degrades to the previous behaviour
 * instead of breaking.
 *
 * Duplicate names are decided by a precedence ladder, never by list
 * order (war-room round 2, F-7 \u2014 both first-wins and last-wins were
 * coin flips): (1) the slot's compiled default id, Atlassian's managed
 * field; (2) schema-type compatibility; (3) custom fields over system
 * fields; (4) the lowest numeric customfield id (ids allocate
 * monotonically, so the oldest field is the one teams populate; a
 * later admin duplicate is the higher id). Every discarded duplicate
 * is named in a warning so a wrong pick is diagnosable.
 */
export function resolveFieldMap(fields: JiraFieldInfo[]): JiraFieldMap {
  const byName = new Map<string, JiraFieldInfo[]>();
  for (const field of fields) {
    const name = field.name.trim().toLowerCase();
    const list = byName.get(name) ?? [];
    list.push(field);
    byName.set(name, list);
  }
  const numericId = (id: string): number => {
    const match = /(\d+)$/.exec(id);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  const pick = (
    names: string[],
    fallback: string | null,
    defaultId: string | null,
    schemaOk: (field: JiraFieldInfo) => boolean,
  ): string | null => {
    const candidates: JiraFieldInfo[] = [];
    for (const name of names) {
      candidates.push(...(byName.get(name) ?? []));
    }
    if (candidates.length === 0) return fallback;
    let pool = candidates;
    const ladder: Array<(field: JiraFieldInfo) => boolean> = [
      (field) => defaultId !== null && field.id === defaultId,
      schemaOk,
      (field) => field.custom,
    ];
    for (const rung of ladder) {
      const survivors = pool.filter(rung);
      if (survivors.length > 0) pool = survivors;
      if (pool.length === 1) break;
    }
    pool.sort((a, b) => numericId(a.id) - numericId(b.id));
    const winner = pool[0];
    if (!winner) return fallback;
    if (candidates.length > 1) {
      const discarded = candidates.filter((field) => field.id !== winner.id);
      console.warn(
        `ReadySet: duplicate fields named "${names[0]}" \u2014 using ${winner.id}, ignoring ${discarded
          .map((field) => field.id)
          .join(', ')}`,
      );
    }
    return winner.id;
  };
  return {
    storyPoints:
      pick(
        ['story points', 'story point estimate'],
        DEFAULT_FIELD_MAP.storyPoints,
        DEFAULT_FIELD_MAP.storyPoints,
        (field) => field.schemaType === undefined || field.schemaType === 'number',
      ) ?? DEFAULT_FIELD_MAP.storyPoints,
    epicLink:
      pick(
        ['epic link'],
        DEFAULT_FIELD_MAP.epicLink,
        DEFAULT_FIELD_MAP.epicLink,
        (field) =>
          field.schemaCustom === undefined ||
          field.schemaCustom.includes('gh-epic-link') ||
          field.schemaType === 'string',
      ) ?? DEFAULT_FIELD_MAP.epicLink,
    acceptanceCriteria: pick(
      ['acceptance criteria'],
      DEFAULT_FIELD_MAP.acceptanceCriteria,
      null,
      (field) =>
        field.schemaType === undefined ||
        field.schemaType === 'string' ||
        field.schemaType === 'any',
    ),
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
  // Upgrade pack: scoring reads the issue type for the bug pack. It
  // is requested on every REST/search fetch (fieldsFor) but is ALSO
  // gate-exempt below — absence degrades to "not a bug", never to a
  // refused payload.
  'issuetype',
] as const;

/**
 * Scoring keys the completeness gate below does NOT require, even
 * though scoring reads them: Jira OMITS `parent` from an issue
 * payload entirely when the issue has no parent — in REST/search
 * responses (even when the field is explicitly requested) and in
 * event payloads alike. Absence is therefore authoritative "no
 * parent", never evidence of a skeleton, and `normalizeIssue`
 * already reads it as `fields.parent?.key ?? null`.
 *
 * Live-verified 2026-11-17 via `forge logs`: the first gate build
 * required `parent`, so every real fetch of RS-2 was refused
 * ("missing: parent, customfield_10014") and the corrupt stored 35
 * could never heal — the panel kept serving it and every event
 * refetch kept it. A gate must never require a key Jira does not
 * return. (The legacy epic-link field is likewise omitted when
 * unset, but custom fields never gate — see below.)
 *
 * `issuetype` is exempt for a different reason (upgrade pack): it is
 * requested on every fetch ReadySet makes, but if some payload shape
 * ever omits it, the safe degradation is `normalizeIssue`'s "" — the
 * issue is scored without the bug pack — never a refused payload.
 */
export const GATE_EXEMPT_FIELD_KEYS: ReadonlySet<string> = new Set(['parent', 'issuetype']);

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
 *
 * One exception, learned live the same night: `parent` is exempt
 * (GATE_EXEMPT_FIELD_KEYS) because Jira omits it when unset, so
 * its absence proves nothing. Every other standard field IS
 * returned when asked, so its absence still proves a skeleton —
 * and a sparse skeleton omits many of them at once, never just
 * `parent`.
 */
export function isScoreablePayload(raw: RawJiraIssue): boolean {
  const fields = (raw?.fields ?? {}) as Record<string, unknown>;
  return SCORING_FIELD_KEYS.every(
    (key) => GATE_EXEMPT_FIELD_KEYS.has(key) || fields[key] !== undefined,
  );
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
    issueType: fields.issuetype?.name ?? '',
    updated: fields.updated ?? '',
  };
}

/**
 * Issues of a project in stable key order for checkpointed scans.
 * Done issues are excluded unless the project's Done policy counts
 * them (war-room A3): a scan that never returns Done issues also
 * never *sees* them, so reconciliation deleted their records nightly
 * and the `include` policy could never survive a scan.
 */
/** Jira Cloud project-key shape: an uppercase letter, then uppercase/digits/underscore. */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export function isValidProjectKey(projectKey: unknown): projectKey is string {
  return typeof projectKey === 'string' && PROJECT_KEY_RE.test(projectKey);
}

export function projectScanJql(projectKey: string, includeDone = false): string {
  // Validation at the sink (war-room round 2, F-16): every caller is
  // checked today, but a legacy roster entry planted before validation
  // existed would otherwise be interpolated into JQL forever.
  if (!isValidProjectKey(projectKey)) {
    throw new Error(`ReadySet: invalid project key "${String(projectKey)}"`);
  }
  return includeDone
    ? `project = "${projectKey}" ORDER BY key ASC`
    : `project = "${projectKey}" AND statusCategory != Done ORDER BY key ASC`;
}

/**
 * The set of issue keys in a project that the given (user) adapter can
 * see, via paginated search — the visibility boundary for serving
 * stored scores (war-room round 2, E #1/#2 + D2/D3): KVS records carry
 * no Jira permissions, so any read surface serving them to a user must
 * intersect with what that user can browse. Bounded at `maxPages`
 * pages; callers fail closed when the search itself fails.
 */
export async function getVisibleIssueKeys(
  adapter: JiraAdapter,
  projectKey: string,
  maxPages = 10,
  pageSize = 100,
): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await adapter.searchIssues(
      `project = "${projectKey}" ORDER BY key ASC`,
      token,
      pageSize,
    );
    for (const issue of result.issues) keys.add(issue.key);
    if (result.isLast || !result.nextPageToken) return keys;
    token = result.nextPageToken;
  }
  return keys;
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
  { id: 'customfield_10016', name: 'Story Points', custom: true, schemaType: 'number' },
  {
    id: 'customfield_10014',
    name: 'Epic Link',
    custom: true,
    schemaType: 'string',
    schemaCustom: 'com.pyxis.greenhopper.jira:gh-epic-link',
  },
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
  readonly setScorePropertyCalls: Array<{ issueKey: string; value: { score: number; grade: string; updatedAt: string } }> = [];
  readonly deleteScorePropertyCalls: string[] = [];
  /** When set, setScoreProperty throws it (best-effort contract tests). */
  setScorePropertyError: Error | null = null;
  /** Projects the "current user" administers; null = all projects. */
  adminProjects: ReadonlySet<string> | null = null;
  /** Projects the "current user" may edit issues in; null = all. */
  editProjects: ReadonlySet<string> | null = null;
  /** Projects the "current user" may browse; null = all (round 2). */
  browseProjects: ReadonlySet<string> | null = null;
  /** Issue keys invisible to the "current user" (issue-level security,
   *  round 2): getIssue throws for them and search omits them. */
  hiddenIssues: ReadonlySet<string> = new Set();

  constructor(
    private readonly issues: RawJiraIssue[],
    private readonly fields: JiraFieldInfo[] = DEFAULT_FAKE_FIELDS,
  ) {}

  async getIssue(issueKey: string): Promise<RawJiraIssue> {
    this.getIssueCalls.push(issueKey);
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue || this.hiddenIssues.has(issueKey)) {
      throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    }
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
    let pool = this.issues.filter((issue) => !this.hiddenIssues.has(issue.key));
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

  async hasProjectPermission(projectKey: string, permission?: string): Promise<boolean> {
    if (permission === 'EDIT_ISSUES') {
      return this.editProjects === null || this.editProjects.has(projectKey);
    }
    if (permission === 'BROWSE_PROJECTS') {
      return this.browseProjects === null || this.browseProjects.has(projectKey);
    }
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

  readonly updateSummaryCalls: Array<{ issueKey: string; summary: string }> = [];

  async updateSummary(issueKey: string, summary: string): Promise<void> {
    this.updateSummaryCalls.push({ issueKey, summary });
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue) throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    issue.fields.summary = summary;
  }

  readonly assignToUserCalls: Array<{ issueKey: string; accountId: string }> = [];
  /** When set, assignToUser throws it (best-effort contract tests). */
  assignError: Error | null = null;

  async assignToUser(issueKey: string, accountId: string): Promise<void> {
    this.assignToUserCalls.push({ issueKey, accountId });
    if (this.assignError) throw this.assignError;
    const issue = this.issues.find((candidate) => candidate.key === issueKey);
    if (!issue) throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    issue.fields.assignee = { displayName: 'Current User', accountId } as never;
  }

  async addComment(issueKey: string, body: AdfDoc): Promise<void> {
    this.addCommentCalls.push({ issueKey, body: structuredClone(body) });
    if (!this.issues.some((candidate) => candidate.key === issueKey)) {
      throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    }
  }

  async setScoreProperty(
    issueKey: string,
    value: { score: number; grade: string; updatedAt: string },
  ): Promise<void> {
    this.setScorePropertyCalls.push({ issueKey, value: { ...value } });
    if (this.setScorePropertyError) throw this.setScorePropertyError;
    if (!this.issues.some((candidate) => candidate.key === issueKey)) {
      throw new Error(`FakeJiraAdapter: unknown issue ${issueKey}`);
    }
  }

  async deleteScoreProperty(issueKey: string): Promise<void> {
    this.deleteScorePropertyCalls.push(issueKey);
  }
}
