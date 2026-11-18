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
  | 'due-date'
  | 'repro-steps';

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
  /** Issue type name, e.g. "Story" | "Bug" | "Task" ("" when absent). */
  issueType: string;
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
    'repro-steps': boolean;
  };
}

/**
 * Provenance of a stored score — which input the score was computed
 * from. The event handler's cache early-exit (cross-review B10) only
 * trusts records whose input is known complete; records written before
 * provenance existed (`undefined`) are rescored once and healed
 * (cross-review A-NEW-3).
 *
 * - `rest`: computed from a full REST issue fetch (panel, scans, and
 *   the event handler's fallback when custom fields were omitted).
 * - `event`: computed from an event payload whose custom fields were
 *   delivered (`customFieldsStatus: INCLUDED`) and merged in.
 */
export type ScoreSource = 'rest' | 'event';

/** One point in an issue's score history (upgrade pack, review #3). */
export interface ScoreHistoryEntry {
  score: number;
  /**
   * The grade the score carried under the thresholds in force when
   * it was computed — a historical fact, kept for trend reporting
   * ("became Ready this week"). Live surfaces re-derive the grade
   * from the score under CURRENT thresholds, so after a threshold
   * change the same score value can legitimately show a different
   * grade in history than on the panel (upgrade cross-review A6).
   */
  grade: Grade;
  /** ISO timestamp of the rescore that produced this value. */
  at: string;
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
   * Fingerprint of everything the score depends on besides the issue
   * itself: project settings, the rubric version, and the effective
   * Jira field map (cross-review A8). A cache entry is only reused when
   * the fingerprint still matches.
   */
  settingsFingerprint: string;
  /** Which input produced this record; absent on pre-provenance records. */
  source?: ScoreSource;
  /**
   * Score history, oldest first, capped at 10 entries (upgrade pack).
   * Seeded with the first computed score and appended ONLY when the
   * score value changes, so the panel can show the latest transition
   * ("20 → 60 · Nov 17"). Absent on records written before the upgrade.
   */
  history?: ScoreHistoryEntry[];
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

/** Where an improvement draft came from (phase 2a). */
export type DraftSource = 'llm' | 'template';

/**
 * One improvement draft for an issue, cached in KVS under
 * `draft:{issueKey}:{contentHash}` (DESIGN.md §5.2). The sections are
 * the structured form the Apply flow turns into ADF via
 * `buildAdfFromSections` — the draft is stored structured, never as
 * pre-built ADF, so the panel can render it for review first.
 */
export interface ImprovementDraft {
  issueKey: string;
  projectKey: string;
  /**
   * Hash of everything the draft was generated from (summary,
   * description text, dedicated AC text, the failed check ids, the
   * rubric version). If the issue changes, the hash changes and the
   * cached draft no longer applies — Apply re-checks it before
   * writing, so a stale draft can never overwrite newer edits.
   */
  contentHash: string;
  source: DraftSource;
  /** Section headings + paragraphs (see `lib/adf.ts` DraftSection). */
  sections: Array<{ heading: string; paragraphs: string[] }>;
  /** The issue's score when the draft was generated. */
  scoreAtDraft: number;
  /** ISO timestamp of generation. */
  generatedAt: string;
}
