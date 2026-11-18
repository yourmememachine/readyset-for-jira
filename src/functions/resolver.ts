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
  incompleteScoringPayloadError,
  isScoreablePayload,
  missingScoringFields,
  normalizeIssue,
  projectScanJql,
  resolveFieldMap,
  type JiraAdapter,
  type JiraFieldMap,
} from '../lib/jira';
import { gradeForScore, scoreIssue } from '../lib/rubric';
import { RUBRIC_VERSION } from '../lib/rubric-config';
import { normalizeSettings, type ScanStatus, type ScoreStore } from '../lib/store';
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
}

export interface ScanResult {
  projectKey: string;
  scanned: number;
  resumed: boolean;
  complete: boolean;
}

const PAGE_SIZE = 100;
const ADMIN_PERMISSION = 'ADMINISTER_PROJECTS';

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
    fieldMap,
  });
}

/**
 * The field map scoring should use: an injected map (tests) wins;
 * otherwise the per-site map resolved once from `GET /rest/api/3/field`
 * and cached in KVS (cross-review B8).
 */
export async function getEffectiveFieldMap(deps: ResolverDeps): Promise<JiraFieldMap> {
  if (deps.fieldMap) return deps.fieldMap;
  const cached = await deps.store.getFieldMap();
  if (cached) return cached;
  const resolved = resolveFieldMap(await deps.jira.listFields());
  await deps.store.setFieldMap(resolved);
  return resolved;
}

async function canAdminister(deps: ResolverDeps, projectKey: string): Promise<boolean> {
  const adapter = deps.jiraUser ?? deps.jira;
  try {
    return await adapter.hasProjectPermission(projectKey, ADMIN_PERMISSION);
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
    issueUpdated: issue.updated,
    computedAt: now.toISOString(),
    settingsFingerprint: settingsFingerprint(settings, fieldMap),
    source,
  };
}

export async function scoreAndStore(
  deps: ResolverDeps,
  issue: NormalizedIssue,
  settings: ProjectSettings,
  fieldMap: JiraFieldMap,
  source: ScoreSource,
): Promise<StoredScore> {
  const record = toStoredScore(issue, settings, fieldMap, source, deps.now ? deps.now() : new Date());
  const previous = await deps.store.getScore(record.issueKey);
  await deps.store.saveScore(record);
  // Entity property (upgrade pack, review #2): keep the JQL-searchable
  // score in step with the stored record. Best-effort — a failed
  // property write is logged and never fails the scoring path; the
  // next rescore rewrites it. Skipped when score and grade are
  // unchanged (upgrade cross-review B2/A5): scans and the nightly
  // rescan rescore everything, and an unconditional serial PUT per
  // issue would eat the invocation budget and Jira rate limits for
  // no change in the searchable state. With the skip, the property's
  // updatedAt means "score last changed".
  if (previous && previous.score === record.score && previous.grade === record.grade) {
    return record;
  }
  try {
    await deps.jira.setScoreProperty(record.issueKey, {
      score: record.score,
      grade: gradeForScore(record.score, settings),
      updatedAt: record.computedAt,
    });
  } catch (error) {
    console.warn(
      `ReadySet: score property write failed for ${record.issueKey}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return record;
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
  const fieldMap = await getEffectiveFieldMap(deps);
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
      return panelPayload(stored, storedSettings, true);
    }
    throw incompleteScoringPayloadError(payload.issueKey, missing);
  }
  const issue = normalizeIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const cached = await deps.store.getScore(issue.key);
  if (
    cached &&
    cached.issueUpdated === issue.updated &&
    cached.settingsFingerprint === settingsFingerprint(settings, fieldMap)
  ) {
    return panelPayload(cached, settings, true);
  }
  const record = await scoreAndStore(deps, issue, settings, fieldMap, 'rest');
  return panelPayload(record, settings, false);
}

/**
 * Run at most `maxPages` pages of a project scan, checkpointing after
 * every page. A scan is a sequence of chunks sharing one checkpoint;
 * only a chunk sequence that reaches `isLast` completes the scan (and,
 * when `reconcile` is set, deletes records the scan never saw).
 */
async function runScanChunk(
  deps: ResolverDeps,
  adapter: JiraAdapter,
  projectKey: string,
  maxPages: number,
  fresh: boolean,
  reconcile: boolean,
): Promise<ScanResult> {
  const settings = await deps.store.getSettings(projectKey);
  const fieldMap = await getEffectiveFieldMap(deps);
  if (fresh) await deps.store.clearRescanCheckpoint(projectKey);
  const checkpoint = fresh ? undefined : await deps.store.getRescanCheckpoint(projectKey);
  let token: string | null = checkpoint?.nextPageToken ?? null;
  const seen = new Set<string>(checkpoint?.seenKeys ?? []);
  let resumed =
    checkpoint !== undefined && (checkpoint.nextPageToken !== null || checkpoint.seenKeys.length > 0);
  let scanned = 0;
  let restartedAfterBadToken = false;

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    let page;
    try {
      page = await adapter.searchIssues(projectScanJql(projectKey), token, PAGE_SIZE, fieldMap);
    } catch (err) {
      if (token !== null && !restartedAfterBadToken && err instanceof InvalidPageTokenError) {
        // The stored token was rejected (expired/rotated): tokens are
        // opaque cursors, not durable offsets, so the only safe resume
        // is a restart from page one (cross-review A-NEW-2). Scoring
        // is idempotent, so restarting loses nothing. Any OTHER error
        // checkpoints and surfaces below — restarting on those could
        // loop forever against a persistent failure.
        restartedAfterBadToken = true;
        resumed = false;
        token = null;
        seen.clear();
        pageIndex -= 1;
        continue;
      }
      await deps.store.setRescanCheckpoint(projectKey, {
        nextPageToken: token,
        seenKeys: [...seen],
      });
      await deps.store.setScanState(projectKey, {
        status: 'failed',
        updatedAt: nowIso(deps),
        error: errMessage(err),
      });
      throw err;
    }
    for (const raw of page.issues) {
      if (!isScoreablePayload(raw)) {
        // Never score a partial search payload over a good record
        // (live RS-2 incident rule). The issue still counts as SEEN,
        // so a reconciling scan does not delete its stored score —
        // the record is stale, not wrong, and the next complete
        // payload heals it.
        console.error(
          `ReadySet: scan of ${projectKey} skipped ${raw.key}: incomplete payload ` +
            `(missing: ${missingScoringFields(raw, fieldMap).join(', ')})`,
        );
        seen.add(raw.key);
        continue;
      }
      const issue = normalizeIssue(raw, fieldMap);
      await scoreAndStore(deps, issue, settings, fieldMap, 'rest');
      seen.add(issue.key);
      scanned += 1;
    }
    if (page.isLast || !page.nextPageToken) {
      if (reconcile) {
        // Complete scan (isLast reached): anything stored for this
        // project that the scan did not see is closed, deleted, or
        // moved away — remove it (cross-review A2/B9). Never run this
        // on a partial scan (B-NEW-1).
        const existing = await deps.store.getProjectScores(projectKey);
        for (const record of existing) {
          if (!seen.has(record.issueKey)) {
            await deps.store.deleteScore(record.issueKey);
          }
        }
      }
      await deps.store.clearRescanCheckpoint(projectKey);
      await deps.store.setScanState(projectKey, { status: 'complete', updatedAt: nowIso(deps) });
      await deps.store.registerProject(projectKey);
      return { projectKey, scanned, resumed, complete: true };
    }
    token = page.nextPageToken;
    await deps.store.setRescanCheckpoint(projectKey, {
      nextPageToken: token,
      seenKeys: [...seen],
    });
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
  let scanned = 0;
  let resumed = false;
  let fresh = !options.resume;
  for (let chunkCount = 0; chunkCount < 10_000; chunkCount += 1) {
    const chunk = await runScanChunk(deps, deps.jira, projectKey, 1, fresh, true);
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
  await deps.store.registerProject(projectKey);
  let state = await deps.store.getScanState(projectKey);
  if (!state || state.status !== 'complete') {
    try {
      await runScanChunk(deps, deps.jiraUser ?? deps.jira, projectKey, 1, false, false);
    } catch {
      // The chunk already recorded the failure in the scan state; the
      // dashboard renders with the failure visible instead of throwing.
    }
    state = await deps.store.getScanState(projectKey);
  }
  const records = await deps.store.getProjectScores(projectKey);
  const settings = await deps.store.getSettings(projectKey);
  const stats = computeProjectStats(projectKey, records, settings);
  const fieldMap = await getEffectiveFieldMap(deps);
  const canEditSettings = await canAdminister(deps, projectKey);
  return {
    projectKey,
    stats,
    settings,
    scanStatus: state?.status ?? 'scanning',
    ...(state?.status === 'failed' && state.error ? { scanError: state.error } : {}),
    fieldMap,
    canEditSettings,
  };
}

/** Manual "Rescan now": start a fresh scan (first chunk only). */
export async function rescanProject(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ScanResult> {
  await deps.store.setScanState(payload.projectKey, {
    status: 'scanning',
    updatedAt: nowIso(deps),
  });
  return runScanChunk(deps, deps.jiraUser ?? deps.jira, payload.projectKey, 1, true, false);
}

/** Continue an in-progress scan by one chunk (frontend-driven). */
export async function continueScanProject(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ScanResult> {
  return runScanChunk(deps, deps.jiraUser ?? deps.jira, payload.projectKey, 1, false, false);
}

export async function getSettings(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ProjectSettings> {
  return deps.store.getSettings(payload.projectKey);
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
  if (!(await canAdminister(deps, payload.projectKey))) {
    throw new Error('Only project administrators can change ReadySet settings.');
  }
  const current = await deps.store.getSettings(payload.projectKey);
  const next = normalizeSettings(payload.settings, current);
  await deps.store.saveSettings(payload.projectKey, next);
  await deps.store.registerProject(payload.projectKey);
  return next;
}
