/**
 * Shared types for ReadySet.
 *
 * The scoring engine works on {@link NormalizedIssue} — a flat, plain-data
 * view of a Jira issue — so it never touches the Jira REST shape or Forge
 * APIs. Conversion from the REST payload happens once, in `jira.ts`.
 */

export type Grade = 'ready' | 'almost' | 'not-ready';

export type CheckId =
  | 'description'
  | 'acceptance-criteria'
  | 'estimate'
  | 'priority'
  | 'assignee'
  | 'labels-or-components'
  | 'linked-work'
  | 'no-placeholders'
  | 'summary-quality'
  | 'due-date';

/** Flat, scoring-ready view of a Jira issue. All fields are plain data. */
export interface NormalizedIssue {
  key: string;
  projectKey: string;
  summary: string;
  /** Plain text extracted from the description (ADF flattened). */
  descriptionText: string;
  /**
   * Plain text of a dedicated acceptance-criteria field, when the site has
   * one mapped. `null` when no such field exists — the rubric then looks
   * for an acceptance-criteria section inside the description instead.
   */
  acceptanceCriteriaText: string | null;
  storyPoints: number | null;
  originalEstimateSeconds: number | null;
  /** Priority name, e.g. "Highest" | "High" | "Medium" | "Low" | "Lowest". */
  priority: string | null;
  /** Assignee display name, or null when unassigned. */
  assignee: string | null;
  labels: string[];
  components: string[];
  /** Number of issue links (inward + outward). */
  linkedIssueCount: number;
  parentKey: string | null;
  epicKey: string | null;
  /** ISO date (yyyy-mm-dd) or null. */
  dueDate: string | null;
  statusName: string;
  /** Jira status category key: "new" | "indeterminate" | "done" | ... */
  statusCategory: string;
  /** Issue `updated` timestamp (ISO) — used as the cache freshness key. */
  updated: string;
}

export interface CheckResult {
  id: CheckId;
  label: string;
  /** Points this check contributes when passed. */
  weight: number;
  passed: boolean;
  /** What the rubric actually found, in one line. */
  detail: string;
  /** One-line fix instruction, shown when the check fails. */
  fixHint: string;
}

export interface ReadinessScore {
  issueKey: string;
  /** 0–100, renormalized over the checks that are enabled. */
  score: number;
  grade: Grade;
  checks: CheckResult[];
}

/** Per-project settings, stored in KVS under `settings:{projectKey}`. */
export interface ProjectSettings {
  /** Score at or above which an issue counts as Ready. */
  readyThreshold: number;
  /** Score at or above which an issue counts as Almost (below: Not ready). */
  almostThreshold: number;
  /** The two opinionated checks can be switched off per project. When a
   *  check is off it is excluded from scoring and weights renormalize. */
  checksEnabled: {
    estimate: boolean;
    'due-date': boolean;
  };
}

/** What gets cached in KVS per issue (`score:{issueKey}`). */
export interface StoredScore extends ReadinessScore {
  projectKey: string;
  summary: string;
  statusName: string;
  statusCategory: string;
  /** The issue's `updated` value at compute time — freshness key. */
  issueUpdated: string;
  /** ISO timestamp of when ReadySet computed this score. */
  computedAt: string;
  /**
   * Fingerprint of the settings (thresholds + enabled checks) this score
   * was computed under. A cache entry is only reused when the fingerprint
   * still matches the project's current settings.
   */
  settingsFingerprint: string;
}

export interface ProjectStats {
  projectKey: string;
  totalScored: number;
  openScored: number;
  averageScore: number;
  /** Share of open issues at Ready grade, 0–100 (one decimal). */
  percentReady: number;
  counts: Record<Grade, number>;
  /** Lowest-scoring open issues, worst first, capped by the caller. */
  worstOffenders: StoredScore[];
}
