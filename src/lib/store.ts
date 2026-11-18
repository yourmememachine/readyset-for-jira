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
  set(key: string, value: unknown): Promise<void>;
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

  async get<T>(key: string): Promise<T | undefined> {
    const value = this.map.get(key);
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.parse(JSON.stringify(value)));
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async list(
    prefix: string,
    limit: number,
    cursor?: string,
  ): Promise<{ keys: string[]; nextCursor?: string }> {
    const all = [...this.map.keys()].filter((key) => key.startsWith(prefix)).sort();
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
export const rescanKey = (projectKey: string): string => `rescan:${projectKey}`;
export const scanStateKey = (projectKey: string): string => `scanstate:${projectKey}`;
export const projectMarkerKey = (projectKey: string): string => `proj:${projectKey}`;
export const PROJECTS_PREFIX = 'proj:';
export const FIELDMAP_KEY = 'fieldmap';
export const ROSTER_KEY = 'rescan-roster';
export const draftKey = (issueKey: string, contentHash: string): string =>
  `draft:${issueKey}:${contentHash}`;
export const summaryDraftKey = (issueKey: string, contentHash: string): string =>
  `sumdraft:${issueKey}:${contentHash}`;

export interface RescanCheckpoint {
  /** Opaque Jira `nextPageToken`; null means "start from the first page". */
  nextPageToken: string | null;
  /**
   * Keys the in-progress scan has seen so far, persisted across
   * invocations: reconciliation after a resumed scan may only delete
   * records outside the *complete* seen set (cross-review B-NEW-1/2).
   */
  seenKeys: string[];
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
    if (value.length === 0 || value.length > 40) continue;
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
  const ready = clampThreshold(input?.readyThreshold, base.readyThreshold);
  const almost = Math.min(ready, clampThreshold(input?.almostThreshold, base.almostThreshold));
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
    const name = raw.trim().replace(/^#+\s*/, '');
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

  async getRescanCheckpoint(projectKey: string): Promise<RescanCheckpoint | undefined> {
    return this.kv.get<RescanCheckpoint>(rescanKey(projectKey));
  }

  async setRescanCheckpoint(projectKey: string, checkpoint: RescanCheckpoint): Promise<void> {
    await this.kv.set(rescanKey(projectKey), checkpoint);
  }

  async clearRescanCheckpoint(projectKey: string): Promise<void> {
    await this.kv.delete(rescanKey(projectKey));
  }

  async getFieldMap(): Promise<JiraFieldMap | undefined> {
    return this.kv.get<JiraFieldMap>(FIELDMAP_KEY);
  }

  async setFieldMap(fieldMap: JiraFieldMap): Promise<void> {
    await this.kv.set(FIELDMAP_KEY, fieldMap);
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
    await this.kv.set(draftKey(draft.issueKey, draft.contentHash), draft);
  }

  async getSummaryDraft(
    issueKey: string,
    contentHash: string,
  ): Promise<SummaryDraft | undefined> {
    return this.kv.get<SummaryDraft>(summaryDraftKey(issueKey, contentHash));
  }

  async saveSummaryDraft(draft: SummaryDraft): Promise<void> {
    await this.kv.set(summaryDraftKey(draft.issueKey, draft.contentHash), draft);
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
    await this.kv.set(key, current);
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
