/**
 * Score/settings persistence over a minimal key-value interface.
 *
 * Key scheme (DESIGN.md §5.2, revised in cross-review round 3):
 *   score:{issueKey}        → StoredScore
 *   idx:{projectKey}:{key}  → 1 (project membership marker, one key per
 *                             issue — cross-review A3/B6: the old single
 *                             array value lost entries under concurrent
 *                             writes and had a 240 KiB ceiling)
 *   settings:{projectKey}   → ProjectSettings
 *   proj:{projectKey}       → 1 (project registered for nightly rescan;
 *                             written only when the dashboard is opened
 *                             or settings are saved — cross-review B10)
 *   rescan:{projectKey}     → scan checkpoint (opaque page token + the
 *                             keys seen so far, for reconciliation)
 *   scanstate:{projectKey}  → { status, updatedAt, error? }
 *   fieldmap                → the site's resolved JiraFieldMap (B8)
 *   rescan-roster           → { lastCompletedProject } rotation cursor
 *                             for the nightly rescan (cross-review A18)
 *   draft:{issueKey}:{hash} → ImprovementDraft (phase 2a): an Improve
 *                             draft cached by the content hash it was
 *                             generated from (DESIGN.md §5.2), so a
 *                             repeat Improve on unchanged content is
 *                             free and Apply can verify freshness.
 *
 * Enumeration uses prefix listing (`list`), which on Forge KVS is
 * eventually consistent: a just-written membership marker can briefly
 * be missing from a listing. That trade was accepted in the debate —
 * a transient listing lag self-heals on the next read, while the old
 * read-modify-write array lost entries permanently and silently.
 * Per-issue `get`s remain strictly consistent.
 *
 * Production binds {@link KeyValueStore} to Forge KVS (`forge-store.ts`);
 * tests bind it to {@link InMemoryKV}. Values are JSON-cloned in the
 * in-memory implementation so accidental shared references (which Forge
 * KVS would never allow) fail loudly in tests instead of in production.
 */
import { ACCEPTANCE_CRITERIA_HEADING, ALL_CHECK_IDS, DEFAULT_SETTINGS } from './rubric-config';
import type { JiraFieldMap } from './jira';
import type { CheckId, ImprovementDraft, ProjectSettings, StoredScore, SummaryDraft } from './types';

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * List keys under a prefix, one page at a time. `cursor` is opaque;
   * pass the previous page's `nextCursor` to continue.
   */
  list(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<{ keys: string[]; nextCursor?: string }>;
}

export class InMemoryKV implements KeyValueStore {
  private readonly map = new Map<string, unknown>();
  private readonly expiries = new Map<string, number>();

  private expired(key: string): boolean {
    const at = this.expiries.get(key);
    return at !== undefined && at <= Date.now();
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (this.expired(key)) {
      this.map.delete(key);
      this.expiries.delete(key);
      return undefined;
    }
    const value = this.map.get(key);
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  async set(key: string, value: unknown, options?: { ttlSeconds?: number }): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
    if (options?.ttlSeconds !== undefined) {
      this.expiries.set(key, Date.now() + options.ttlSeconds * 1000);
    } else {
      this.expiries.delete(key);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
    this.expiries.delete(key);
  }

  async list(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<{ keys: string[]; nextCursor?: string }> {
    const all = [...this.map.keys()]
      .filter((key) => key.startsWith(prefix) && !this.expired(key))
      .sort();
    const after = cursor ? all.filter((key) => key > cursor) : all;
    const keys = after.slice(0, limit);
    const last = keys[keys.length - 1];
    return {
      keys,
      ...(after.length > limit && last !== undefined ? { nextCursor: last } : {}),
    };
  }

  /** Test/debug helper: all keys currently held. */
  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}

export const scoreKey = (issueKey: string): string => `score:${issueKey}`;
export const memberKey = (projectKey: string, issueKey: string): string =>
  `idx:${projectKey}:${issueKey}`;
export const memberPrefix = (projectKey: string): string => `idx:${projectKey}:`;
export const settingsKey = (projectKey: string): string => `settings:${projectKey}`;
export const appRescanKey = (projectKey: string): string => `rescan-app:${projectKey}`;
export const uiRescanKey = (projectKey: string): string => `rescan-ui:${projectKey}`;
export const seenShardKey = (projectKey: string, scope: 'app' | 'ui', pageIndex: number): string =>
  `rescan-seen:${projectKey}:${scope}:${pageIndex}`;
export const scanStateKey = (projectKey: string): string => `scanstate:${projectKey}`;
export const projectMarkerKey = (projectKey: string): string => `proj:${projectKey}`;
export const PROJECTS_PREFIX = 'proj:';
export const FIELDMAP_KEY = 'fieldmap';
export const ROSTER_KEY = 'rescan-roster';
export const draftKey = (issueKey: string, contentHash: string): string =>
  `draft:${issueKey}:${contentHash}`;
export const summaryDraftKey = (issueKey: string, contentHash: string): string =>
  `sumdraft:${issueKey}:${contentHash}`;
export const propertyDeletionKey = (issueKey: string): string => `propdel:${issueKey}`;
export const PROPERTY_DELETION_PREFIX = 'propdel:';
export const llmQuotaKey = (issueKey: string, day: Date): string =>
  `llmquota:${issueKey}:${day.toISOString().slice(0, 10)}`;

/**
 * Scan checkpoint, v2 (war-room round 2, D4/F-1): a constant-size
 * manifest — the seen set lives in per-page shards
 * (`rescan-seen:{project}:{scope}:{pageIndex}`, ≤ one page of keys
 * each), so the value never approaches the 240 KiB KVS limit and a
 * scan's total checkpoint writes are O(n), not O(n²). The pre-v2
 * shape (one value carrying every seen key, under the unversioned
 * `rescan:{project}` key shared by both origins) is never read again:
 * legacy checkpoints are abandoned, not migrated — their origin is
 * unrecoverable, and a UI-written one is exactly the poison the
 * per-origin split exists to discard.
 */
export interface ScanCheckpoint {
  v: 2;
  /** When this scan sequence started (ISO). Reconcile never deletes a
   *  record computed after this instant (round 2, D6). */
  startedAt: string;
  /** Token that fetches the CURRENT page; null = the first page. */
  pageToken: string | null;
  /** Index of the current page; its seen-shard may be partially filled. */
  pageIndex: number;
}

export type ScanStatus = 'complete' | 'scanning' | 'failed';

export interface ScanState {
  status: ScanStatus;
  updatedAt: string;
  /** User-presentable failure detail when status is 'failed'. */
  error?: string;
}

export interface RosterCheckpoint {
  lastCompletedProject: string;
}

function clampThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Merge a (possibly partial, possibly legacy) settings object over a
 * base and normalize it: thresholds clamped to 0–100, non-finite values
 * replaced by the base's, and almost ≤ ready enforced. Shared by the
 * read path and the save path so the two can never disagree
 * (cross-review A10).
 */
/** Trim, dedupe (case-insensitive), and cap a free-text list setting (Wave 3). */
export function normalizeStringList(input: unknown, base: string[]): string[] {
  if (!Array.isArray(input)) return [...base];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of input) {
    if (typeof candidate !== 'string') continue;
    const value = candidate.trim();
    // 80 chars: real Jira status names can run long, and a dropped
    // entry silently un-excludes an issue (cross-review A15).
    if (value.length === 0 || value.length > 80) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= 12) break;
  }
  return result;
}

export function normalizeSettings(
  input: Partial<ProjectSettings> | undefined,
  base: ProjectSettings,
): ProjectSettings {
  // Threshold floor (war-room round 2, E #5): an issue passing ZERO
  // substantive checks can still score 20 (priority + vacuous passes),
  // so a readyThreshold at or below 20 grades content-free issues
  // Ready. The floor keeps calibration free above the degenerate
  // corner: Ready ∈ [30, 100], and Almost strictly below Ready (the
  // old clamp permitted equality, collapsing the two tiers — and at
  // 0/0 making both validators vacuous).
  const ready = Math.max(30, clampThreshold(input?.readyThreshold, base.readyThreshold));
  const almostRaw = clampThreshold(input?.almostThreshold, base.almostThreshold);
  const almost = Math.min(ready - 1, almostRaw);
  const checksEnabled = {} as Record<CheckId, boolean>;
  const weights = {} as Record<CheckId, number>;
  for (const id of ALL_CHECK_IDS) {
    checksEnabled[id] = input?.checksEnabled?.[id] ?? base.checksEnabled[id];
    weights[id] = clampWeight(input?.weights?.[id], base.weights[id]);
  }
  // Degenerate-config guard (Wave 2): if every enabled check carries
  // weight 0 the denominator collapses and every issue scores 0 —
  // almost certainly a settings mistake, so fall back to the base
  // weights rather than brick the project's scoring.
  const enabledWeight = ALL_CHECK_IDS.reduce(
    (sum, id) => sum + (checksEnabled[id] ? weights[id] : 0),
    0,
  );
  if (enabledWeight === 0) {
    for (const id of ALL_CHECK_IDS) weights[id] = base.weights[id];
  }
  // Twin guard (Wave 2 cross-review A2): if EVERY check is disabled the
  // rubric has nothing to score and every issue collapses to 0 — fall
  // back to the base toggles rather than persist a rubric with no checks.
  if (ALL_CHECK_IDS.every((id) => !checksEnabled[id])) {
    for (const id of ALL_CHECK_IDS) checksEnabled[id] = base.checksEnabled[id];
  }
  // Substantive-minimum guard (war-room round 2, E #5): due-date and
  // no-placeholders pass vacuously on an empty issue, so a config that
  // enables ONLY vacuous checks (or strips the substantive ones below
  // a working weight) renormalizes a bare issue to 100 — a gate that
  // looks calibrated and means nothing. Same remedy as the guards
  // above: fall back to the base toggles AND weights.
  const VACUOUS_CHECKS: ReadonlySet<CheckId> = new Set(['due-date', 'no-placeholders']);
  const substantiveWeight = ALL_CHECK_IDS.reduce(
    (sum, id) => sum + (!VACUOUS_CHECKS.has(id) && checksEnabled[id] ? weights[id] : 0),
    0,
  );
  const coreMissing =
    (!checksEnabled.description || weights.description === 0) &&
    (!checksEnabled['acceptance-criteria'] || weights['acceptance-criteria'] === 0);
  if (coreMissing || substantiveWeight < 30) {
    for (const id of ALL_CHECK_IDS) {
      checksEnabled[id] = base.checksEnabled[id];
      weights[id] = base.weights[id];
    }
  }
  return {
    readyThreshold: ready,
    almostThreshold: almost,
    checksEnabled,
    weights,
    improveSections: normalizeImproveSections(input?.improveSections, base.improveSections),
    excludedIssueTypes: normalizeStringList(input?.excludedIssueTypes, base.excludedIssueTypes),
    excludedStatuses: normalizeStringList(input?.excludedStatuses, base.excludedStatuses),
    donePolicy: input?.donePolicy === 'include' ? 'include' : 'exclude',
    analyticsEnabled: input?.analyticsEnabled === true,
  };
}

/**
 * Sanitize the Improve section list (Wave 2): trim, drop empties and
 * over-long names, dedupe case-insensitively, cap at 6 — and guarantee
 * exactly one Acceptance-criteria heading the rubric can actually read.
 * The rubric's detector is anchored (the heading must START with
 * "Acceptance criteria"), so a heading that merely contains the phrase
 * ("Team acceptance criteria") is dropped here rather than producing a
 * section the rubric would never credit (cross-review A3/B2); duplicate
 * AC headings collapse to the first (A4); the cap is applied after any
 * insertion so the result never exceeds 6.
 */
export function normalizeImproveSections(
  input: string[] | undefined,
  base: string[],
): string[] {
  const source = Array.isArray(input) && input.length > 0 ? input : base;
  const seen = new Set<string>();
  const sections: string[] = [];
  let acSeen = false;
  for (const raw of source) {
    if (typeof raw !== 'string') continue;
    // Control characters and newlines are stripped server-side
    // (war-room round 2, E #6): a section name is interpolated into
    // the LLM *system* prompt, and the frontend's comma-split is not
    // a trust boundary — a name carrying "\nSYSTEM: …" must never
    // survive normalization as a free-standing prompt line.
    const name = raw
      .replace(/[\u0000-\u001F\u007F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^#+\s*/, '');
    if (name.length === 0 || name.length > 60) continue;
    const isAcHeading = /^acceptance criteria\b/i.test(name);
    if (/acceptance criteria/i.test(name) && !isAcHeading) continue;
    if (isAcHeading) {
      if (acSeen) continue;
      acSeen = true;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sections.push(name);
  }
  if (sections.length === 0) return [...base];
  if (!acSeen) {
    sections.splice(Math.max(0, sections.length - 1), 0, ACCEPTANCE_CRITERIA_HEADING);
  }
  while (sections.length > 6) {
    const acIndex = sections.findIndex((name) => /^acceptance criteria\b/i.test(name));
    const lastIndex = sections.length - 1;
    sections.splice(lastIndex === acIndex ? lastIndex - 1 : lastIndex, 1);
  }
  return sections;
}

function clampWeight(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

const LIST_PAGE_SIZE = 100;

export class ScoreStore {
  constructor(private readonly kv: KeyValueStore) {}

  /** Enumerate every key under a prefix, following cursors. */
  private async listAllKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.kv.list(prefix, LIST_PAGE_SIZE, cursor);
      keys.push(...page.keys);
      if (!page.nextCursor) return keys;
      cursor = page.nextCursor;
    }
  }

  async saveScore(record: StoredScore): Promise<void> {
    const previous = await this.getScore(record.issueKey);
    // Monotonic guard (war-room round 2, D12/F-13): triggers deliver
    // at-least-once and Apply races its own event, so two invocations
    // can read-modify-write the same record concurrently. If the
    // stored record was computed STRICTLY later than the incoming one,
    // the incoming write is stale by construction — drop it rather
    // than clobber newer score/checks (or resurrect a propertySynced
    // state the newer record's failed PUT never earned). Equal
    // timestamps proceed: sequential saves under one clock are the
    // normal case, not a race.
    if (previous && previous.computedAt > record.computedAt) {
      return;
    }
    if (previous && previous.projectKey !== record.projectKey) {
      // The issue moved projects: drop the stale membership so the old
      // project stops counting it immediately (cross-review A2).
      await this.kv.delete(memberKey(previous.projectKey, record.issueKey));
    }
    // Score history (upgrade pack, review #3): seeded with the first
    // computed score, appended only when the score value changes,
    // capped at the latest 10 points. A pre-upgrade record seeds the
    // history from its own score/computedAt on its next save.
    const entry = { score: record.score, grade: record.grade, at: record.computedAt };
    if (!previous) {
      record.history = [entry];
    } else {
      const history = previous.history ?? [
        { score: previous.score, grade: previous.grade, at: previous.computedAt },
      ];
      record.history =
        previous.score === record.score ? history : [...history, entry].slice(-10);
      // Became-Ready bookkeeping (cross-review A7): a transition into
      // Ready on a score change stamps lastBecameReadyAt; otherwise the
      // previous stamp carries forward (first-seen Ready is not a
      // transition and never stamps).
      if (previous.grade !== 'ready' && record.grade === 'ready' && previous.score !== record.score) {
        record.lastBecameReadyAt = record.computedAt;
      } else if (previous.lastBecameReadyAt) {
        record.lastBecameReadyAt = previous.lastBecameReadyAt;
      }
    }
    await this.kv.set(scoreKey(record.issueKey), record);
    await this.kv.set(memberKey(record.projectKey, record.issueKey), 1);
  }

  async getScore(issueKey: string): Promise<StoredScore | undefined> {
    return this.kv.get<StoredScore>(scoreKey(issueKey));
  }

  /**
   * Flip `propertySynced` to true ONLY if the stored record is still
   * exactly the record that was synced (war-room round 2, F-13): the
   * panel/event retry paths PUT the cached score's property, and
   * saving the whole stale record back would clobber a rescore that
   * landed in between. A mismatch means a newer record exists — its
   * own sync state governs, and this flip is dropped.
   */
  async markPropertySynced(
    issueKey: string,
    expected: { score: number; grade: string; computedAt: string },
  ): Promise<boolean> {
    const current = await this.getScore(issueKey);
    if (!current || current.propertySynced === true) return false;
    if (
      current.score !== expected.score ||
      current.grade !== expected.grade ||
      current.computedAt !== expected.computedAt
    ) {
      return false;
    }
    await this.kv.set(scoreKey(issueKey), { ...current, propertySynced: true });
    return true;
  }

  /** Tombstone a failed entity-property deletion for later retry (F-6). */
  async addPropertyDeletionTombstone(issueKey: string): Promise<void> {
    await this.kv.set(propertyDeletionKey(issueKey), 1);
  }

  async clearPropertyDeletionTombstone(issueKey: string): Promise<void> {
    await this.kv.delete(propertyDeletionKey(issueKey));
  }

  async listPropertyDeletionTombstones(limit = 50): Promise<string[]> {
    const keys = await this.listAllKeys(PROPERTY_DELETION_PREFIX);
    return keys.slice(0, limit).map((key) => key.slice(PROPERTY_DELETION_PREFIX.length));
  }

  /** Remove a score and its project membership (delete / reconcile). */
  async deleteScore(issueKey: string): Promise<void> {
    const record = await this.getScore(issueKey);
    if (record) {
      await this.kv.delete(memberKey(record.projectKey, issueKey));
    }
    await this.kv.delete(scoreKey(issueKey));
  }

  async getProjectScores(projectKey: string): Promise<StoredScore[]> {
    const prefix = memberPrefix(projectKey);
    const keys = await this.listAllKeys(prefix);
    const issueKeys = keys.map((key) => key.slice(prefix.length));
    const records = await Promise.all(
      issueKeys.map((issueKey) => this.kv.get<StoredScore>(scoreKey(issueKey))),
    );
    return records.filter(
      (record): record is StoredScore =>
        record !== undefined && record.projectKey === projectKey,
    );
  }

  /**
   * Register a project for the nightly rescan. Called when its
   * dashboard is opened or its settings are saved — NOT on every scored
   * issue (cross-review B10 / DESIGN.md §5.6).
   */
  async registerProject(projectKey: string): Promise<void> {
    await this.kv.set(projectMarkerKey(projectKey), 1);
  }

  async getKnownProjects(): Promise<string[]> {
    const keys = await this.listAllKeys(PROJECTS_PREFIX);
    return keys.map((key) => key.slice(PROJECTS_PREFIX.length));
  }

  async getScanState(projectKey: string): Promise<ScanState | undefined> {
    return this.kv.get<ScanState>(scanStateKey(projectKey));
  }

  async setScanState(projectKey: string, state: ScanState): Promise<void> {
    await this.kv.set(scanStateKey(projectKey), state);
  }

  async getSettings(projectKey: string): Promise<ProjectSettings> {
    const stored = await this.kv.get<Partial<ProjectSettings>>(settingsKey(projectKey));
    return normalizeSettings(stored, DEFAULT_SETTINGS);
  }

  async saveSettings(projectKey: string, settings: ProjectSettings): Promise<void> {
    await this.kv.set(settingsKey(projectKey), settings);
  }

  /**
   * Scan checkpoints v2 (see {@link ScanCheckpoint}): a constant-size
   * manifest per origin — app scans write `rescan-app:{project}`,
   * UI chunks write `rescan-ui:{project}` — plus one seen-shard per
   * page. Origins never share state (war-room B8), and the legacy
   * shared key is never read again (round 2, F-1).
   */
  private checkpointKey(projectKey: string, scope: 'app' | 'ui'): string {
    return scope === 'ui' ? uiRescanKey(projectKey) : appRescanKey(projectKey);
  }

  async getScanCheckpoint(
    projectKey: string,
    scope: 'app' | 'ui' = 'app',
  ): Promise<ScanCheckpoint | undefined> {
    const stored = await this.kv.get<ScanCheckpoint>(this.checkpointKey(projectKey, scope));
    // Anything that is not a v2 manifest (a legacy value under a
    // reused key) is abandoned, never resumed.
    if (!stored || stored.v !== 2) return undefined;
    return stored;
  }

  async setScanCheckpoint(
    projectKey: string,
    checkpoint: ScanCheckpoint,
    scope: 'app' | 'ui' = 'app',
  ): Promise<void> {
    await this.kv.set(this.checkpointKey(projectKey, scope), checkpoint);
  }

  async setSeenShard(
    projectKey: string,
    scope: 'app' | 'ui',
    pageIndex: number,
    issueKeys: string[],
  ): Promise<void> {
    await this.kv.set(seenShardKey(projectKey, scope, pageIndex), issueKeys);
  }

  async getSeenShard(
    projectKey: string,
    scope: 'app' | 'ui',
    pageIndex: number,
  ): Promise<string[]> {
    return (await this.kv.get<string[]>(seenShardKey(projectKey, scope, pageIndex))) ?? [];
  }

  /** Union of shards 0..pageCount-1 — the complete seen set at reconcile. */
  async getSeenUnion(
    projectKey: string,
    scope: 'app' | 'ui',
    pageCount: number,
  ): Promise<Set<string>> {
    const seen = new Set<string>();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      for (const key of await this.getSeenShard(projectKey, scope, pageIndex)) {
        seen.add(key);
      }
    }
    return seen;
  }

  async clearScanCheckpoint(
    projectKey: string,
    scope: 'app' | 'ui' = 'app',
    pageCount = 0,
  ): Promise<void> {
    await this.kv.delete(this.checkpointKey(projectKey, scope));
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      await this.kv.delete(seenShardKey(projectKey, scope, pageIndex));
    }
  }

  /**
   * The field map is cached WITH its resolution time (war-room round
   * 2, D8): a site configuration treated as immutable stayed wrong
   * forever. Callers treat a map older than 24 h as stale and
   * re-resolve. A legacy bare map (written before the wrapper) reads
   * as resolvedAt 0 — one forced re-resolution, then it heals.
   */
  async getFieldMap(): Promise<{ map: JiraFieldMap; resolvedAt: number } | undefined> {
    const stored = await this.kv.get<
      { map: JiraFieldMap; resolvedAt: number } | JiraFieldMap
    >(FIELDMAP_KEY);
    if (!stored) return undefined;
    if ('map' in stored && 'resolvedAt' in stored) {
      return stored as { map: JiraFieldMap; resolvedAt: number };
    }
    return { map: stored as JiraFieldMap, resolvedAt: 0 };
  }

  async setFieldMap(fieldMap: JiraFieldMap, resolvedAt: number): Promise<void> {
    await this.kv.set(FIELDMAP_KEY, { map: fieldMap, resolvedAt });
  }

  async getRosterCheckpoint(): Promise<RosterCheckpoint | undefined> {
    return this.kv.get<RosterCheckpoint>(ROSTER_KEY);
  }

  async setRosterCheckpoint(checkpoint: RosterCheckpoint): Promise<void> {
    await this.kv.set(ROSTER_KEY, checkpoint);
  }

  async getDraft(issueKey: string, contentHash: string): Promise<ImprovementDraft | undefined> {
    return this.kv.get<ImprovementDraft>(draftKey(issueKey, contentHash));
  }

  async saveDraft(draft: ImprovementDraft): Promise<void> {
    // Drafts are cache, not state (war-room round 2, D11/E12): a
    // 30-day TTL bounds the draft:{issue}:{hash} key family, which
    // otherwise grew forever — drafts were previously deleted only
    // on a successful Apply.
    await this.kv.set(draftKey(draft.issueKey, draft.contentHash), draft, {
      ttlSeconds: 30 * 24 * 60 * 60,
    });
  }

  /** Remove a consumed draft (war-room B22): an applied draft's hash is
   *  stale by construction, and leaving it in KVS only orphans it. */
  async deleteDraft(issueKey: string, contentHash: string): Promise<void> {
    await this.kv.delete(draftKey(issueKey, contentHash));
  }

  async getSummaryDraft(
    issueKey: string,
    contentHash: string,
  ): Promise<SummaryDraft | undefined> {
    return this.kv.get<SummaryDraft>(summaryDraftKey(issueKey, contentHash));
  }

  async saveSummaryDraft(draft: SummaryDraft): Promise<void> {
    await this.kv.set(summaryDraftKey(draft.issueKey, draft.contentHash), draft, {
      ttlSeconds: 30 * 24 * 60 * 60,
    });
  }

  /** Remove a consumed summary draft (war-room B22, as deleteDraft). */
  async deleteSummaryDraft(issueKey: string, contentHash: string): Promise<void> {
    await this.kv.delete(summaryDraftKey(issueKey, contentHash));
  }

  /** Delete every draft (both kinds) held for an issue — the
   *  issue-deleted event path (war-room round 2, E #12): drafts for a
   *  dead issue are unreachable garbage without this. */
  async deleteIssueDrafts(issueKey: string): Promise<void> {
    for (const prefix of [`draft:${issueKey}:`, `sumdraft:${issueKey}:`]) {
      const keys = await this.listAllKeys(prefix);
      for (const key of keys) {
        await this.kv.delete(key);
      }
    }
  }

  /**
   * Daily LLM-call quota counter (war-room round 2, E #12): drafting
   * is open to any viewer and every distinct content hash is a billed
   * call, so Improve caps LLM drafts per issue per day and falls back
   * to the (free, deterministic) template beyond the cap. Returns the
   * count AFTER incrementing. Deliberately NOT gated on the analytics
   * opt-in — this is cost control, not telemetry.
   */
  async incrementLlmQuota(issueKey: string, now: Date): Promise<number> {
    const key = llmQuotaKey(issueKey, now);
    const current = (await this.kv.get<number>(key)) ?? 0;
    const next = current + 1;
    await this.kv.set(key, next, { ttlSeconds: 2 * 24 * 60 * 60 });
    return next;
  }

  /**
   * Opt-in analytics (Wave 3): increment one daily counter for the
   * project. Callers gate on settings.analyticsEnabled — the counters
   * exist only when the project admin turned them on.
   */
  async incrementAnalytics(
    projectKey: string,
    field: AnalyticsField,
    now: Date,
  ): Promise<void> {
    const key = analyticsKey(projectKey, now);
    const current = (await this.kv.get<AnalyticsDay>(key)) ?? { scores: 0, drafts: 0, applies: 0 };
    current[field] += 1;
    // 14-day TTL (war-room round 2, D11): only the last 7 days are
    // ever read, and the per-day keys otherwise accumulated forever.
    // Accepted residual (D12): this read-modify-write can lose an
    // increment under true concurrency — the counters are advisory
    // and labelled approximate in the UI; no correctness consumer
    // reads them.
    await this.kv.set(key, current, { ttlSeconds: 14 * 24 * 60 * 60 });
  }

  /** Sum the last `days` daily counters (including today) for the dashboard. */
  async getAnalyticsTotals(
    projectKey: string,
    days: number,
    now: Date,
  ): Promise<{ scores: number; drafts: number; applies: number }> {
    const totals = { scores: 0, drafts: 0, applies: 0 };
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
      const entry = await this.kv.get<AnalyticsDay>(analyticsKey(projectKey, day));
      if (entry) {
        totals.scores += entry.scores;
        totals.drafts += entry.drafts;
        totals.applies += entry.applies;
      }
    }
    return totals;
  }
}

/** One day of opt-in usage counters (Wave 3). */
export interface AnalyticsDay {
  scores: number;
  drafts: number;
  applies: number;
}

export type AnalyticsField = keyof AnalyticsDay;

export const analyticsKey = (projectKey: string, day: Date): string =>
  `analytics:${projectKey}:${day.toISOString().slice(0, 10)}`;
