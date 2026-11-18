/**
 * Score/settings persistence over a minimal key-value interface.
 *
 * Key scheme (DESIGN.md §5.2):
 *   score:{issueKey}      → StoredScore
 *   idx:{projectKey}      → string[] of issue keys scored in the project
 *   settings:{projectKey} → ProjectSettings
 *   projects              → string[] of project keys ReadySet has seen
 *   rescan:{projectKey}   → { nextStartAt: number } checkpoint, when present
 *
 * Production binds {@link KeyValueStore} to Forge KVS (`forge-store.ts`);
 * tests bind it to {@link InMemoryKV}. Values are JSON-cloned in the
 * in-memory implementation so accidental shared references (which Forge
 * KVS would never allow) fail loudly in tests instead of in production.
 */
import { DEFAULT_SETTINGS } from './rubric-config';
import type { ProjectSettings, StoredScore } from './types';

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
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

  /** Test/debug helper: all keys currently held. */
  keys(): string[] {
    return [...this.map.keys()].sort();
  }
}

export const scoreKey = (issueKey: string): string => `score:${issueKey}`;
export const indexKey = (projectKey: string): string => `idx:${projectKey}`;
export const settingsKey = (projectKey: string): string => `settings:${projectKey}`;
export const rescanKey = (projectKey: string): string => `rescan:${projectKey}`;
export const PROJECTS_KEY = 'projects';

export interface RescanCheckpoint {
  nextStartAt: number;
}

function mergeSettings(stored: Partial<ProjectSettings> | undefined): ProjectSettings {
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  return {
    readyThreshold: stored.readyThreshold ?? DEFAULT_SETTINGS.readyThreshold,
    almostThreshold: stored.almostThreshold ?? DEFAULT_SETTINGS.almostThreshold,
    checksEnabled: {
      ...DEFAULT_SETTINGS.checksEnabled,
      ...(stored.checksEnabled ?? {}),
    },
  };
}

export class ScoreStore {
  constructor(private readonly kv: KeyValueStore) {}

  async saveScore(record: StoredScore): Promise<void> {
    await this.kv.set(scoreKey(record.issueKey), record);
    const idx = (await this.kv.get<string[]>(indexKey(record.projectKey))) ?? [];
    if (!idx.includes(record.issueKey)) {
      idx.push(record.issueKey);
      await this.kv.set(indexKey(record.projectKey), idx);
    }
    const projects = (await this.kv.get<string[]>(PROJECTS_KEY)) ?? [];
    if (!projects.includes(record.projectKey)) {
      projects.push(record.projectKey);
      await this.kv.set(PROJECTS_KEY, projects);
    }
  }

  async getScore(issueKey: string): Promise<StoredScore | undefined> {
    return this.kv.get<StoredScore>(scoreKey(issueKey));
  }

  async getProjectScores(projectKey: string): Promise<StoredScore[]> {
    const idx = (await this.kv.get<string[]>(indexKey(projectKey))) ?? [];
    const records: StoredScore[] = [];
    for (const issueKey of idx) {
      const record = await this.kv.get<StoredScore>(scoreKey(issueKey));
      if (record) records.push(record);
    }
    return records;
  }

  /** True once a project has been scanned or any of its issues scored. */
  async hasProjectIndex(projectKey: string): Promise<boolean> {
    return (await this.kv.get<string[]>(indexKey(projectKey))) !== undefined;
  }

  /**
   * Record that a project was scanned even if it produced no scores, so
   * "scanned, nothing open" is distinguishable from "never scanned" and
   * empty projects are not rescanned on every dashboard open.
   */
  async markProjectScanned(projectKey: string): Promise<void> {
    if (!(await this.hasProjectIndex(projectKey))) {
      await this.kv.set(indexKey(projectKey), []);
    }
    const projects = (await this.kv.get<string[]>(PROJECTS_KEY)) ?? [];
    if (!projects.includes(projectKey)) {
      projects.push(projectKey);
      await this.kv.set(PROJECTS_KEY, projects);
    }
  }

  async getKnownProjects(): Promise<string[]> {
    return (await this.kv.get<string[]>(PROJECTS_KEY)) ?? [];
  }

  async getSettings(projectKey: string): Promise<ProjectSettings> {
    const stored = await this.kv.get<Partial<ProjectSettings>>(settingsKey(projectKey));
    return mergeSettings(stored);
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
}
