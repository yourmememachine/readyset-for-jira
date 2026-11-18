/**
 * UI resolver handlers — the backend behind the issue panel and the
 * project dashboard.
 *
 * Handlers are plain async functions over injected dependencies
 * ({@link ResolverDeps}); `src/index.ts` binds them to `@forge/resolver`
 * with the production Jira/KVS adapters. Tests drive these exact
 * handlers with fakes, so what is tested is what ships.
 *
 * Cross-review round 3 reshaped the scan machinery:
 * - Pagination follows the `/search/jql` contract: opaque
 *   `nextPageToken`s, `isLast` termination (B1).
 * - Scans run in bounded chunks. A UI invocation has a 25 s budget, so
 *   the dashboard never runs a full scan inline — it reads KVS, kicks
 *   at most one chunk, and reports scan progress (B4 + A1's separate
 *   "scanned" state). The frontend continues chunk-by-chunk.
 * - A scan that reaches `isLast` reconciles: stored records the scan
 *   did not see (closed, deleted, moved away) are deleted (A2/B9).
 *   Reconciliation only runs for app-adapter scans — a user-adapter
 *   scan cannot see issues hidden from that user and must never
 *   delete their records (B12 interaction).
 */
import { computeProjectStats } from '../lib/aggregate';
import {
  DEFAULT_FIELD_MAP,
  InvalidPageTokenError,
  getVisibleIssueKeys,
  incompleteScoringPayloadError,
  isScoreablePayload,
  isValidProjectKey,
  missingScoringFields,
  normalizeIssue,
  projectScanJql,
  resolveFieldMap,
  type JiraAdapter,
  type JiraFieldMap,
} from '../lib/jira';
import { gradeForScore, scoreIssue } from '../lib/rubric';
import { RUBRIC_VERSION } from '../lib/rubric-config';
import {
  normalizeSettings,
  type ScanCheckpoint,
  type ScanStatus,
  type ScoreStore,
} from '../lib/store';
import type {
  CheckResult,
  Grade,
  NormalizedIssue,
  ProjectSettings,
  ProjectStats,
  ScoreHistoryEntry,
  ScoreSource,
  StoredScore,
} from '../lib/types';

export interface ResolverDeps {
  /** App-permission adapter (triggers, scheduled work). */
  jira: JiraAdapter;
  /**
   * User-permission adapter for UI-invoked reads (cross-review B12).
   * Falls back to `jira` when absent (tests, non-UI callers).
   */
  jiraUser?: JiraAdapter;
  store: ScoreStore;
  /** Injected field map (tests); production resolves it per site (B8). */
  fieldMap?: JiraFieldMap;
  now?: () => Date;
}

export interface IssuePanelPayload {
  issueKey: string;
  summary: string;
  statusName: string;
  score: number;
  grade: Grade;
  checks: CheckResult[];
  computedAt: string;
  fromCache: boolean;
  /** Score history, oldest first (upgrade pack); empty when unknown. */
  history: ScoreHistoryEntry[];
  /** True when the project's exclusions cover this issue (Wave 3): no score is kept for it. */
  excluded?: boolean;
}

export interface ProjectDashboardPayload {
  projectKey: string;
  stats: ProjectStats;
  settings: ProjectSettings;
  /** Three-state scan status (cross-review A1/B4). */
  scanStatus: ScanStatus;
  /** Present when scanStatus is 'failed'. */
  scanError?: string;
  /** The site's resolved field map, shown read-only (B8). */
  fieldMap: JiraFieldMap;
  /** Whether the viewing user may change project settings (B13). */
  canEditSettings: boolean;
  /** Last-7-days usage counters, present only when analytics are enabled (Wave 3). */
  analytics?: { scores: number; drafts: number; applies: number };
}

export interface ScanResult {
  projectKey: string;
  scanned: number;
  resumed: boolean;
  complete: boolean;
}

/** App-side (scheduled) page size: the 900 s invocation budget fits it. */
const PAGE_SIZE = 100;
/**
 * UI page size (war-room round 2, D5): a UI resolver invocation has a
 * 25 s budget and a 100-issue chunk of REST search + per-issue KVS
 * writes + property PUTs cannot fit it — the chunk died mid-page with
 * no failure state recorded and its checkpoint pointing at the page
 * start, so retries rescored the same page forever. 25 issues per
 * chunk fits the budget; intra-page checkpointing covers the rest.
 */
const UI_PAGE_SIZE = 25;
const ADMIN_PERMISSION = 'ADMINISTER_PROJECTS';
const BROWSE_PERMISSION = 'BROWSE_PROJECTS';

/**
 * Project keys are interpolated into a quoted JQL string and written
 * to the nightly-rescan roster, so payload-supplied keys are held to
 * Jira's own key shape (war-room B11): an uppercase letter followed by
 * uppercase letters, digits, or underscores. Anything else is refused
 * before it can break out of the JQL quote or pollute the roster.
 * The regex itself lives in lib/jira (PROJECT_KEY_RE) so the JQL sink
 * enforces the same shape (round 2, F-16).
 */
export function requireValidProjectKey(projectKey: string): void {
  if (!isValidProjectKey(projectKey)) {
    throw new Error(`ReadySet: invalid project key "${projectKey}"`);
  }
}

function nowIso(deps: ResolverDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Everything a cached score depends on besides the issue itself:
 * settings, the rubric version, and the effective field map. If any of
 * them change, previously computed scores must not pose as fresh
 * (cross-review A8).
 */
export function settingsFingerprint(
  settings: ProjectSettings,
  fieldMap: JiraFieldMap = DEFAULT_FIELD_MAP,
): string {
  return JSON.stringify({
    v: RUBRIC_VERSION,
    ready: settings.readyThreshold,
    almost: settings.almostThreshold,
    // Wave 2: every toggle and every weight feeds the fingerprint —
    // any settings change must rescore rather than serve stale cache.
    checksEnabled: settings.checksEnabled,
    weights: settings.weights,
    improveSections: settings.improveSections,
    // Wave 3 review A3: the exclusion lists decide whether a record
    // may exist at all — omitting them let the event cache early-exit
    // keep a newly excluded issue's record alive indefinitely.
    excludedIssueTypes: settings.excludedIssueTypes,
    excludedStatuses: settings.excludedStatuses,
    fieldMap,
  });
}

/**
 * Best-effort removal of an issue's JQL entity property (cross-review
 * B4): the stored record going away is not enough — the property is
 * what JQL searches and the workflow validators read. Used by the
 * exclusion paths and by scan reconciliation (war-room A2).
 *
 * Round 2 (F-6): returns whether the property is GONE. A failure is
 * tombstoned (`propdel:{issueKey}`) and drained at the next scan
 * start — previously the call was fire-and-forget, so one transient
 * failure orphaned the property permanently: reconcile's record was
 * already deleted and nothing ever retried. Callers that delete a
 * record MUST check the result and keep the record when it is false,
 * so the property and the record never disagree about existence.
 */
export async function clearExcludedProperty(
  deps: ResolverDeps,
  issueKey: string,
): Promise<boolean> {
  try {
    await deps.jira.deleteScoreProperty(issueKey);
    await deps.store.clearPropertyDeletionTombstone(issueKey);
    return true;
  } catch (err) {
    console.warn(`ReadySet: could not delete the score property for ${issueKey}:`, err);
    await deps.store.addPropertyDeletionTombstone(issueKey);
    return false;
  }
}

/** Retry tombstoned property deletions (round 2, F-6). Bounded by the
 *  store's tombstone listing cap; runs at every app-scan start. */
export async function drainPropertyDeletionTombstones(deps: ResolverDeps): Promise<void> {
  const tombstones = await deps.store.listPropertyDeletionTombstones();
  for (const issueKey of tombstones) {
    try {
      await deps.jira.deleteScoreProperty(issueKey);
      await deps.store.clearPropertyDeletionTombstone(issueKey);
    } catch (err) {
      console.warn(`ReadySet: tombstoned property delete still failing for ${issueKey}:`, err);
    }
  }
}

/** Field maps go stale after 24 h (war-room round 2, D8). */
export const FIELD_MAP_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The field map scoring should use, plus whether it is DEGRADED
 * (war-room round 2, F-4): an injected map (tests) wins; otherwise the
 * per-site map resolved from `GET /rest/api/3/field` and cached in KVS
 * with its resolution time (cross-review B8; round-2 D8 — a stale map
 * is re-resolved, and a legacy bare cache counts as resolved at 0).
 *
 * `degraded` means `listFields` threw AND no cached map exists: the
 * returned default map was never resolved against this site, so
 * scoring on it can silently write wrong-field scores to records and
 * properties. Callers decide by path: persistence paths (scans,
 * events, Apply rescore) must refuse; display/draft paths may compute
 * with the defaults read-only. A stale-but-real cached map is NOT
 * degraded — it is a resolved map that is merely old.
 */
export async function getEffectiveFieldMap(
  deps: ResolverDeps,
): Promise<{ fieldMap: JiraFieldMap; degraded: boolean }> {
  if (deps.fieldMap) return { fieldMap: deps.fieldMap, degraded: false };
  const nowMs = (deps.now ? deps.now() : new Date()).getTime();
  const cached = await deps.store.getFieldMap();
  if (cached && nowMs - cached.resolvedAt < FIELD_MAP_STALE_MS) {
    return { fieldMap: cached.map, degraded: false };
  }
  let fields;
  try {
    fields = await deps.jira.listFields();
  } catch (err) {
    console.error('ReadySet: could not list Jira fields:', err);
    if (cached) {
      // Stale cache beats never-resolved defaults: keep serving the
      // real map and retry resolution next call.
      return { fieldMap: cached.map, degraded: false };
    }
    // Nothing cached and resolution failed: degrade to the default
    // ids, UNcached, so the next call retries (war-room A4) — and
    // flag it, so persistence paths can refuse to write on it (F-4).
    return { fieldMap: DEFAULT_FIELD_MAP, degraded: true };
  }
  const resolved = resolveFieldMap(fields);
  await deps.store.setFieldMap(resolved, nowMs);
  return { fieldMap: resolved, degraded: false };
}

export async function canAdminister(deps: ResolverDeps, projectKey: string): Promise<boolean> {
  const adapter = deps.jiraUser ?? deps.jira;
  try {
    return await adapter.hasProjectPermission(projectKey, ADMIN_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Whether the invoking user may BROWSE the project (war-room round 2,
 * D2/D3): the gate for every surface that serves stored scores to a
 * user (dashboard, rescan, Coach project actions). Fails closed — a
 * permission check that errors is a "no".
 */
export async function canBrowseProject(deps: ResolverDeps, projectKey: string): Promise<boolean> {
  const adapter = deps.jiraUser ?? deps.jira;
  try {
    return await adapter.hasProjectPermission(projectKey, BROWSE_PERMISSION);
  } catch {
    return false;
  }
}

function toStoredScore(
  issue: NormalizedIssue,
  settings: ProjectSettings,
  fieldMap: JiraFieldMap,
  source: ScoreSource,
  now: Date,
): StoredScore {
  const scored = scoreIssue(issue, settings);
  return {
    ...scored,
    projectKey: issue.projectKey,
    summary: issue.summary,
    statusName: issue.statusName,
    statusCategory: issue.statusCategory,
    issueType: issue.issueType,
    assignee: issue.assignee,
    labels: [...issue.labels],
    issueUpdated: issue.updated,
    computedAt: now.toISOString(),
    settingsFingerprint: settingsFingerprint(settings, fieldMap),
    source,
  };
}

/**
 * Exclusions (Wave 3): an issue whose type or status is on the
 * project's exclusion lists is never scored. Checked before every
 * scoring entry point via scoreAndStore + the panel.
 */
export function isExcluded(issue: NormalizedIssue, settings: ProjectSettings): boolean {
  const type = issue.issueType.trim().toLowerCase();
  const status = issue.statusName.trim().toLowerCase();
  return (
    settings.excludedIssueTypes.some((candidate) => candidate.toLowerCase() === type) ||
    settings.excludedStatuses.some((candidate) => candidate.toLowerCase() === status)
  );
}

export async function scoreAndStore(
  deps: ResolverDeps,
  issue: NormalizedIssue,
  settings: ProjectSettings,
  fieldMap: JiraFieldMap,
  source: ScoreSource,
): Promise<StoredScore | null> {
  if (isExcluded(issue, settings)) {
    // An excluded issue keeps no record: delete any score stored
    // before the exclusion existed so dashboards drop it too — and
    // clear its JQL property so searches and validators drop it too.
    await deps.store.deleteScore(issue.key);
    await clearExcludedProperty(deps, issue.key);
    return null;
  }
  const record = toStoredScore(issue, settings, fieldMap, source, deps.now ? deps.now() : new Date());
  const previous = await deps.store.getScore(record.issueKey);
  // Entity property (upgrade pack, review #2): keep the JQL-searchable
  // score in step with the stored record. Best-effort — a failed
  // property write is logged and never fails the scoring path.
  // The unchanged-score skip (upgrade cross-review B2/A5) is only
  // sound when the previous write actually landed: the record tracks
  // that as `propertySynced`, and an unsynced record is rewritten by
  // every later rescore until the write lands (war-room A1/C2 — the
  // skip previously made a single failed write permanent and falsified
  // the "nightly rescan backfills" promise). With the skip, the
  // property's updatedAt means "score last changed".
  record.propertySynced = await syncScoreProperty(deps, record, settings, previous);
  await deps.store.saveScore(record);
  if (settings.analyticsEnabled) {
    await deps.store.incrementAnalytics(issue.projectKey, 'scores', deps.now ? deps.now() : new Date());
  }
  return record;
}

/**
 * Write the `readyset` entity property for a record unless the
 * previous record is already known to mirror it. Returns whether the
 * property is now known to be in step — the caller persists that on
 * the record, so a failure is retried by the next rescore instead of
 * being skipped forever.
 */
export async function syncScoreProperty(
  deps: ResolverDeps,
  record: StoredScore,
  settings: ProjectSettings,
  previous: StoredScore | undefined,
): Promise<boolean> {
  if (
    previous?.propertySynced === true &&
    previous.score === record.score &&
    previous.grade === record.grade
  ) {
    return true;
  }
  try {
    await deps.jira.setScoreProperty(record.issueKey, {
      score: record.score,
      grade: gradeForScore(record.score, settings),
      updatedAt: record.computedAt,
    });
    return true;
  } catch (error) {
    console.warn(
      `ReadySet: score property write failed for ${record.issueKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** The panel payload for an excluded issue: no score, and the reason. */
function excludedPanelPayload(
  deps: ResolverDeps,
  issueKey: string,
  summary: string,
  statusName: string,
): IssuePanelPayload {
  return {
    issueKey,
    summary,
    statusName,
    score: 0,
    grade: 'not-ready' as Grade,
    checks: [],
    computedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    fromCache: false,
    history: [],
    excluded: true,
  };
}

function panelPayload(record: StoredScore, settings: ProjectSettings, fromCache: boolean): IssuePanelPayload {
  return {
    issueKey: record.issueKey,
    summary: record.summary,
    statusName: record.statusName,
    score: record.score,
    // Grade is re-derived against current thresholds so a threshold edit
    // is reflected even on a cached score.
    grade: gradeForScore(record.score, settings),
    checks: record.checks,
    computedAt: record.computedAt,
    fromCache,
    history: record.history ?? [],
  };
}

/**
 * Panel data for one issue. Serves the cached score when the issue has
 * not changed and the fingerprint (settings + rubric version + field
 * map) still matches; otherwise rescoring is one pure function call
 * away. UI reads run as the viewing user (B12).
 */
export async function getIssuePanel(
  deps: ResolverDeps,
  payload: { issueKey: string },
): Promise<IssuePanelPayload> {
  const adapter = deps.jiraUser ?? deps.jira;
  const { fieldMap, degraded } = await getEffectiveFieldMap(deps);
  const raw = await adapter.getIssue(payload.issueKey, fieldMap);
  if (!isScoreablePayload(raw)) {
    // A partial payload must never be scored: on the live RS-2
    // incident a skeleton payload minted a 35 over a stored 90, and
    // this resolver then served the poisoned record on Refresh
    // because its `updated` matched. Serve the previous stored
    // record when there is one; otherwise fail loudly rather than
    // mint a partial score.
    const missing = missingScoringFields(raw, fieldMap);
    console.error(
      `ReadySet: incomplete payload for ${payload.issueKey} (missing: ${missing.join(', ')}); ` +
        'serving the stored score if one exists',
    );
    const stored = await deps.store.getScore(payload.issueKey);
    if (stored) {
      const storedSettings = await deps.store.getSettings(stored.projectKey);
      // Exclusion beats the stored record even on a sparse fetch
      // (cross-review A11): the sparse branch used to serve the old
      // score — and keep the record — for an issue the admin had
      // since excluded. The stored record carries the type/status
      // the exclusion check needs.
      if (
        isExcluded(
          { issueType: stored.issueType ?? '', statusName: stored.statusName } as NormalizedIssue,
          storedSettings,
        )
      ) {
        await deps.store.deleteScore(stored.issueKey);
        await clearExcludedProperty(deps, stored.issueKey);
        return excludedPanelPayload(deps, stored.issueKey, stored.summary, stored.statusName);
      }
      return panelPayload(stored, storedSettings, true);
    }
    throw incompleteScoringPayloadError(payload.issueKey, missing);
  }
  const issue = normalizeIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  if (isExcluded(issue, settings)) {
    // Excluded issues keep no score (Wave 3): drop any stored record
    // and tell the panel why it shows no score.
    await deps.store.deleteScore(issue.key);
    await clearExcludedProperty(deps, issue.key);
    return excludedPanelPayload(deps, issue.key, issue.summary, issue.statusName);
  }
  const cached = await deps.store.getScore(issue.key);
  if (
    cached &&
    cached.issueUpdated === issue.updated &&
    cached.settingsFingerprint === settingsFingerprint(settings, fieldMap)
  ) {
    if (cached.propertySynced !== true) {
      // The cached record is fresh, but its entity property never
      // landed (war-room A1, second barrier): serving from cache must
      // not freeze the JQL mirror in its failed state — retry the
      // write here, where the panel already pays a REST round trip.
      // The flip is conditional (round 2, F-13): only mark synced if
      // the stored record is still this exact record.
      const synced = await syncScoreProperty(deps, cached, settings, cached);
      if (synced) {
        await deps.store.markPropertySynced(cached.issueKey, {
          score: cached.score,
          grade: cached.grade,
          computedAt: cached.computedAt,
        });
      }
    }
    return panelPayload(cached, settings, true);
  }
  if (degraded) {
    // Field resolution failed and no cached map exists (round 2,
    // F-4): the panel may DISPLAY a score computed on the default
    // map, but must not persist it — a wrong-field score written to
    // KVS and the entity property would outlive the outage.
    const computed = toStoredScore(
      issue,
      settings,
      fieldMap,
      'rest',
      deps.now ? deps.now() : new Date(),
    );
    return panelPayload(computed, settings, false);
  }
  const record = await scoreAndStore(deps, issue, settings, fieldMap, 'rest');
  if (!record) {
    // Unreachable (exclusion checked above) — fail loudly, never mint.
    throw new Error(`ReadySet: ${issue.key} was excluded during scoring`);
  }
  return panelPayload(record, settings, false);
}

/**
 * Record a scan failure (war-room round 2, F-14): the scan STATE is
 * written first, in its own best-effort try — the round-1 code wrote
 * the checkpoint first, so a KVS failure at exactly that moment left
 * the state stuck at 'scanning' with a 'failed' record that could
 * never be written. The checkpoint write follows, also best-effort;
 * the caller rethrows the ORIGINAL error either way.
 */
async function recordScanFailure(
  deps: ResolverDeps,
  projectKey: string,
  scope: 'app' | 'ui',
  checkpoint: ScanCheckpoint,
  pageSeen: string[],
  err: unknown,
): Promise<void> {
  try {
    await deps.store.setScanState(projectKey, {
      status: 'failed',
      updatedAt: nowIso(deps),
      error: errMessage(err),
    });
  } catch {
    // Best effort: the original error is what propagates.
  }
  try {
    if (pageSeen.length > 0) {
      await deps.store.setSeenShard(projectKey, scope, checkpoint.pageIndex, pageSeen);
    }
    await deps.store.setScanCheckpoint(projectKey, checkpoint, scope);
  } catch {
    // Best effort, as above.
  }
}

/**
 * Run at most `maxPages` pages of a project scan, checkpointing as it
 * goes. A scan is a sequence of chunks sharing one v2 checkpoint
 * (constant-size manifest + per-page seen shards); only a chunk
 * sequence that reaches `isLast` completes the scan (and, when
 * `reconcile` is set, deletes records the scan never saw — except
 * records computed after the scan started, round-2 D6).
 *
 * Checkpointing is intra-page (round 2, D5): every 10 scored issues
 * the current page's shard is rewritten, so a hard kill loses at most
 * 10 issues of work and the manifest never carries the seen set.
 */
async function runScanChunk(
  deps: ResolverDeps,
  adapter: JiraAdapter,
  projectKey: string,
  maxPages: number,
  fresh: boolean,
  reconcile: boolean,
  checkpointScope: 'app' | 'ui',
  pageSize: number = PAGE_SIZE,
): Promise<ScanResult> {
  const settings = await deps.store.getSettings(projectKey);
  const { fieldMap, degraded } = await getEffectiveFieldMap(deps);
  if (degraded) {
    // Persistence path (round 2, F-4): never write scores computed on
    // a never-resolved default map. Recorded like a search failure.
    const err = new Error(
      'ReadySet: Jira field resolution failed and no cached field map exists; scan aborted without scoring',
    );
    await recordScanFailure(
      deps,
      projectKey,
      checkpointScope,
      {
        v: 2,
        startedAt: nowIso(deps),
        pageToken: null,
        pageIndex: 0,
      },
      [],
      err,
    );
    throw err;
  }
  if (fresh) {
    const existing = await deps.store.getScanCheckpoint(projectKey, checkpointScope);
    await deps.store.clearScanCheckpoint(
      projectKey,
      checkpointScope,
      existing ? existing.pageIndex + 1 : 0,
    );
  }
  const checkpoint = fresh
    ? undefined
    : await deps.store.getScanCheckpoint(projectKey, checkpointScope);
  let token: string | null = checkpoint?.pageToken ?? null;
  let pageIndex = checkpoint?.pageIndex ?? 0;
  const startedAt = checkpoint?.startedAt ?? nowIso(deps);
  const seen = new Set<string>(
    await deps.store.getSeenUnion(projectKey, checkpointScope, pageIndex + 1),
  );
  let resumed = checkpoint !== undefined && (checkpoint.pageToken !== null || checkpoint.pageIndex > 0);
  let scanned = 0;
  let restartedAfterBadToken = false;

  for (let pagesThisChunk = 0; pagesThisChunk < maxPages; pagesThisChunk += 1) {
    let page;
    try {
      page = await adapter.searchIssues(
        projectScanJql(projectKey, settings.donePolicy === 'include'),
        token,
        pageSize,
        fieldMap,
      );
    } catch (err) {
      if (token !== null && !restartedAfterBadToken && err instanceof InvalidPageTokenError) {
        // The stored token was rejected (expired/rotated): tokens are
        // opaque cursors, not durable offsets, so the only safe resume
        // is a restart from page one (cross-review A-NEW-2). Scoring
        // is idempotent, so restarting loses nothing. Any OTHER error
        // checkpoints and surfaces below \u2014 restarting on those could
        // loop forever against a persistent failure.
        restartedAfterBadToken = true;
        resumed = false;
        token = null;
        seen.clear();
        await deps.store.clearScanCheckpoint(projectKey, checkpointScope, pageIndex + 1);
        pageIndex = 0;
        pagesThisChunk -= 1;
        continue;
      }
      await recordScanFailure(
        deps,
        projectKey,
        checkpointScope,
        { v: 2, startedAt, pageToken: token, pageIndex },
        [],
        err,
      );
      throw err;
    }
    const pageSeen: string[] = [];
    let sinceShardWrite = 0;
    for (const raw of page.issues) {
      try {
        if (!isScoreablePayload(raw)) {
          // Never score a partial search payload over a good record
          // (live RS-2 incident rule). The issue still counts as SEEN,
          // so a reconciling scan does not delete its stored score \u2014
          // the record is stale, not wrong, and the next complete
          // payload heals it.
          console.error(
            `ReadySet: scan of ${projectKey} skipped ${raw.key}: incomplete payload ` +
              `(missing: ${missingScoringFields(raw, fieldMap).join(', ')})`,
          );
          seen.add(raw.key);
          pageSeen.push(raw.key);
          continue;
        }
        const issue = normalizeIssue(raw, fieldMap);
        const record = await scoreAndStore(deps, issue, settings, fieldMap, 'rest');
        seen.add(issue.key);
        pageSeen.push(issue.key);
        if (record) scanned += 1;
        sinceShardWrite += 1;
        if (sinceShardWrite >= 10) {
          sinceShardWrite = 0;
          await deps.store.setSeenShard(projectKey, checkpointScope, pageIndex, [...pageSeen]);
        }
      } catch (err) {
        // A failure inside the scoring loop is recorded exactly like
        // a search failure (war-room A6): state first, then the
        // checkpoint \u2014 and the checkpoint points at THIS page, whose
        // partial shard is already written, so a resume re-fetches
        // only this page.
        await recordScanFailure(
          deps,
          projectKey,
          checkpointScope,
          { v: 2, startedAt, pageToken: token, pageIndex },
          pageSeen,
          err,
        );
        throw err;
      }
    }
    // The page is fully processed: persist its complete shard.
    await deps.store.setSeenShard(projectKey, checkpointScope, pageIndex, pageSeen);

    const tokenlessComplete =
      !page.isLast && !page.nextPageToken && token === null && page.issues.length < pageSize;
    if (page.isLast || tokenlessComplete) {
      // Tokenless completion (round 2, F-10): a FIRST page that comes
      // back short with no continuation token has returned everything
      // there is \u2014 completing is safe. A tokenless page anywhere else
      // is a contract violation and fails below, without reconciling.
      if (reconcile) {
        try {
          // Complete scan: anything stored for this project that the
          // scan did not see is closed, deleted, or moved away \u2014
          // remove it (cross-review A2/B9). Never run this on a
          // partial scan (B-NEW-1). Two round-2 guards: a record
          // computed AFTER this scan started was created or moved in
          // during the scan and is never deleted (D6); and the entity
          // property is deleted BEFORE the record, the record kept
          // when the delete fails so a later scan retries (F-6 \u2014
          // the tombstone drain covers it in the meantime).
          const existing = await deps.store.getProjectScores(projectKey);
          const scanStartMs = new Date(startedAt).getTime();
          for (const record of existing) {
            if (seen.has(record.issueKey)) continue;
            if (new Date(record.computedAt).getTime() > scanStartMs) continue;
            const propertyGone = await clearExcludedProperty(deps, record.issueKey);
            if (!propertyGone) continue;
            await deps.store.deleteScore(record.issueKey);
          }
        } catch (err) {
          // Reconcile failure (round 2, F-14): record 'failed' and
          // KEEP the checkpoint \u2014 the round-1 code cleared it, so a
          // failed reconcile silently discarded the whole scan.
          await recordScanFailure(
            deps,
            projectKey,
            checkpointScope,
            { v: 2, startedAt, pageToken: token, pageIndex },
            pageSeen,
            err,
          );
          throw err;
        }
      }
      await deps.store.clearScanCheckpoint(projectKey, checkpointScope, pageIndex + 1);
      await deps.store.setScanState(projectKey, { status: 'complete', updatedAt: nowIso(deps) });
      await deps.store.registerProject(projectKey);
      return { projectKey, scanned, resumed, complete: true };
    }
    if (!page.nextPageToken) {
      // Pagination ended without the termination signal (war-room
      // A13): isLast is the contract's only "complete" marker, so a
      // tokenless non-final page is a failed scan \u2014 never a complete
      // one, and never a reason to reconcile a partial seen-set.
      const err = new Error(
        `ReadySet: scan of ${projectKey} ended without a final page marker`,
      );
      await recordScanFailure(
        deps,
        projectKey,
        checkpointScope,
        { v: 2, startedAt, pageToken: token, pageIndex },
        pageSeen,
        err,
      );
      throw err;
    }
    token = page.nextPageToken;
    pageIndex += 1;
    await deps.store.setScanCheckpoint(
      projectKey,
      { v: 2, startedAt, pageToken: token, pageIndex },
      checkpointScope,
    );
  }
  await deps.store.setScanState(projectKey, { status: 'scanning', updatedAt: nowIso(deps) });
  return { projectKey, scanned, resumed, complete: false };
}

/**
 * Scan a project's open issues to completion, chunk by chunk. Used by
 * the scheduled rescan (900 s invocation) — never from a UI resolver.
 * Reconciles on completion.
 */
export async function scanProject(
  deps: ResolverDeps,
  projectKey: string,
  options: { resume: boolean },
): Promise<ScanResult> {
  requireValidProjectKey(projectKey);
  // Retry any property deletions a previous reconcile/exclusion
  // tombstoned (round 2, F-6) before this scan's own reconcile runs.
  await drainPropertyDeletionTombstones(deps);
  let scanned = 0;
  let resumed = false;
  let fresh = !options.resume;
  for (let chunkCount = 0; chunkCount < 10_000; chunkCount += 1) {
    const chunk = await runScanChunk(deps, deps.jira, projectKey, 1, fresh, true, 'app');
    fresh = false;
    scanned += chunk.scanned;
    resumed = resumed || chunk.resumed;
    if (chunk.complete) return { projectKey, scanned, resumed, complete: true };
  }
  throw new Error(`ReadySet: scan of ${projectKey} did not terminate`);
}

/**
 * Dashboard data for one project. Read-only over stored scores plus at
 * most one scan chunk per open (cross-review B4): the page renders
 * whatever is scored, reports the scan state honestly, and the
 * frontend drives continuation. Opening the dashboard registers the
 * project for the nightly rescan (B10).
 */
export async function getProjectDashboard(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ProjectDashboardPayload> {
  const { projectKey } = payload;
  requireValidProjectKey(projectKey);
  // Browse gate BEFORE registration (war-room round 2, D3): opening a
  // dashboard used to register ANY project key into the nightly roster
  // and serve its stored stats to any authenticated user. A user who
  // cannot browse the project gets neither the registration side
  // effect nor the data.
  if (!(await canBrowseProject(deps, projectKey))) {
    throw new Error('ReadySet: you do not have permission to view this project.');
  }
  await deps.store.registerProject(projectKey);
  // Visibility boundary (round 2, E #2/D3): stored records carry no
  // Jira permissions, and project-level browse does not imply every
  // issue is visible (issue-level security exists) — so stats are
  // computed over the subset the viewing user can actually see. If
  // the visibility enumeration itself fails, serve nothing (fail
  // closed) rather than the unfiltered set.
  const userAdapter = deps.jiraUser ?? deps.jira;
  let visibleKeys: Set<string> | undefined;
  try {
    visibleKeys = await getVisibleIssueKeys(userAdapter, projectKey);
  } catch (err) {
    console.error(`ReadySet: visibility check failed for ${projectKey}; serving no scores:`, err);
    visibleKeys = undefined;
  }
  let state = await deps.store.getScanState(projectKey);
  if (visibleKeys !== undefined && (!state || state.status !== 'complete')) {
    try {
      await runScanChunk(deps, userAdapter, projectKey, 1, false, false, 'ui', UI_PAGE_SIZE);
    } catch {
      // The chunk already recorded the failure in the scan state; the
      // dashboard renders with the failure visible instead of throwing.
    }
    state = await deps.store.getScanState(projectKey);
  }
  const allRecords = await deps.store.getProjectScores(projectKey);
  const records = visibleKeys
    ? allRecords.filter((record) => visibleKeys.has(record.issueKey))
    : [];
  const settings = await deps.store.getSettings(projectKey);
  const stats = computeProjectStats(projectKey, records, settings);
  const { fieldMap } = await getEffectiveFieldMap(deps);
  const canEditSettings = await canAdminister(deps, projectKey);
  const analytics = settings.analyticsEnabled
    ? await deps.store.getAnalyticsTotals(projectKey, 7, deps.now ? deps.now() : new Date())
    : undefined;
  return {
    projectKey,
    stats,
    settings,
    scanStatus: state?.status ?? 'scanning',
    ...(state?.status === 'failed' && state.error ? { scanError: state.error } : {}),
    fieldMap,
    canEditSettings,
    ...(analytics ? { analytics } : {}),
  };
}

/** Manual "Rescan now": start a fresh scan (first chunk only).
 *  Browse-gated (round 2, E #3): rescan mutates shared scan state and
 *  writes scores, so a user who cannot see the project cannot drive
 *  its scans either. */
export async function rescanProject(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ScanResult> {
  requireValidProjectKey(payload.projectKey);
  if (!(await canBrowseProject(deps, payload.projectKey))) {
    throw new Error('ReadySet: you do not have permission to view this project.');
  }
  await deps.store.setScanState(payload.projectKey, {
    status: 'scanning',
    updatedAt: nowIso(deps),
  });
  return runScanChunk(
    deps,
    deps.jiraUser ?? deps.jira,
    payload.projectKey,
    1,
    true,
    false,
    'ui',
    UI_PAGE_SIZE,
  );
}

/** Continue an in-progress scan by one chunk (frontend-driven). */
export async function continueScanProject(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ScanResult> {
  requireValidProjectKey(payload.projectKey);
  if (!(await canBrowseProject(deps, payload.projectKey))) {
    throw new Error('ReadySet: you do not have permission to view this project.');
  }
  return runScanChunk(
    deps,
    deps.jiraUser ?? deps.jira,
    payload.projectKey,
    1,
    false,
    false,
    'ui',
    UI_PAGE_SIZE,
  );
}

/**
 * Persist project settings. Gated on project-admin permission
 * (cross-review B13): thresholds redefine "Ready" for the whole
 * project, so a mere viewer must not be able to change them. Values
 * are normalized (clamped, ordered) by the same helper the read path
 * uses (A10).
 */
export async function saveSettings(
  deps: ResolverDeps,
  payload: { projectKey: string; settings: ProjectSettings },
): Promise<ProjectSettings> {
  // Validation and normalization run BEFORE the permission check
  // (round 2, D16-note/F-16): an invalid key must be refused for its
  // own reason, and the normalized value is what the permission gate
  // protects.
  requireValidProjectKey(payload.projectKey);
  const current = await deps.store.getSettings(payload.projectKey);
  const next = normalizeSettings(payload.settings, current);
  if (!(await canAdminister(deps, payload.projectKey))) {
    throw new Error('Only project administrators can change ReadySet settings.');
  }
  // Exclusion impact is computed and logged, never silent (round 2,
  // E #5): widening the exclusion lists deletes stored records and
  // their JQL properties on the next scoring pass, so the change
  // leaves a trace of how many records it orphans. (The resolver's
  // return shape is pinned by the settings form, so the count is
  // logged rather than returned.)
  const records = await deps.store.getProjectScores(payload.projectKey);
  const affected = records.filter((record) =>
    isExcluded(
      { issueType: record.issueType ?? '', statusName: record.statusName } as NormalizedIssue,
      next,
    ),
  ).length;
  if (affected > 0) {
    console.warn(
      `ReadySet: settings saved for ${payload.projectKey}; ${affected} stored score(s) are excluded by the new settings and will be removed on their next scoring pass.`,
    );
  }
  await deps.store.saveSettings(payload.projectKey, next);
  await deps.store.registerProject(payload.projectKey);
  // Mark the scan stale so the next dashboard open rescores the project
  // under the new settings instead of aggregating old-rubric records
  // until the nightly rescan (cross-review A1).
  await deps.store.setScanState(payload.projectKey, {
    status: 'scanning',
    updatedAt: nowIso(deps),
  });
  return next;
}
