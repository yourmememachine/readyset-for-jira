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
import { DEFAULT_SETTINGS } from './rubric-config';
import type { JiraFieldMap } from './jira';
import type { ImprovementDraft, ProjectSettings, StoredScore } from './types';

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
export function normalizeSettings(
  input: Partial<ProjectSettings> | undefined,
  base: ProjectSettings,
): ProjectSettings {
  const ready = clampThreshold(input?.readyThreshold, base.readyThreshold);
  const almost = Math.min(ready, clampThreshold(input?.almostThreshold, base.almostThreshold));
  return {
    readyThreshold: ready,
    almostThreshold: almost,
    checksEnabled: {
      estimate: input?.checksEnabled?.estimate ?? base.checksEnabled.estimate,
      'due-date': input?.checksEnabled?.['due-date'] ?? base.checksEnabled['due-date'],
      'repro-steps': input?.checksEnabled?.['repro-steps'] ?? base.checksEnabled['repro-steps'],
    },
  };
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
}
