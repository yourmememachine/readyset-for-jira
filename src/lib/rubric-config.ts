import type { CheckId, ProjectSettings } from './types';

/**
 * Version of the scoring rubric itself (weights, thresholds baked into
 * check logic, word lists). Part of the panel cache fingerprint
 * (cross-review A8): shipping a build with retuned checks must not
 * leave previously computed scores masquerading as fresh. Bump on any
 * scoring-behaviour change.
 *
 * v2 (cross-review round 3): acceptance-criteria section must have a
 * real body; placeholder scan covers the AC field, "TBC" and "to-do";
 * `todo` needs marker context; summary tokens are deduplicated.
 * v3 (upgrade pack): bug-type issues gain the `repro-steps` check
 * (excluded from scoring for every other issue type).
 * v4 (round 2): meaningful-content tests are conjunctive;
 * the description check gains a distinct-token floor; placeholder
 * matching normalizes zero-width/punctuation/homoglyph evasions;
 * repro credit requires transcribed evidence, never template
 * scaffolding. The bump also invalidates every cached LLM draft —
 * deliberate: drafts parsed under the old extra-section tolerance
 * may carry sections the new parser drops.
 */
export const RUBRIC_VERSION = '4';

/**
 * Rubric weights (DESIGN.md §5.3). Sum of all weights = 100. When a check
 * is disabled in project settings, the score renormalizes over the
 * remaining weights, so the scale stays 0–100.
 */
export const CHECK_WEIGHTS: Record<CheckId, number> = {
  description: 20,
  'acceptance-criteria': 20,
  estimate: 10,
  priority: 5,
  assignee: 10,
  'labels-or-components': 5,
  'linked-work': 10,
  'no-placeholders': 10,
  'summary-quality': 5,
  'due-date': 5,
  'repro-steps': 10,
};

export const CHECK_LABELS: Record<CheckId, string> = {
  description: 'Description is substantial',
  'acceptance-criteria': 'Acceptance criteria present',
  estimate: 'Estimate set',
  priority: 'Priority set',
  assignee: 'Assignee set',
  'labels-or-components': 'Labels or component set',
  'linked-work': 'Linked work or parent/epic',
  'no-placeholders': 'No TBD / placeholder markers',
  'summary-quality': 'Summary is specific',
  'due-date': 'Due date set (high priority)',
  'repro-steps': 'Steps to reproduce documented',
};

/**
 * Issue type names (lowercased) the bug pack applies to: only these
 * types are scored on `repro-steps`; for every other type the check
 * is excluded from the denominator entirely (upgrade pack, review #1).
 */
export const BUG_ISSUE_TYPES: ReadonlySet<string> = new Set(['bug', 'defect', 'incident']);

/** Minimum extracted-text length for the description check. */
export const DESCRIPTION_MIN_CHARS = 280;

/** Priorities (lowercased names) that require a due date. */
export const DUE_DATE_PRIORITIES: ReadonlySet<string> = new Set(['highest', 'high']);

/**
 * Unresolved placeholder markers. Matched case-insensitively as whole
 * tokens (optional plural "s"), plus a few multi-word phrases.
 * ("WIP" is deliberately absent: it is standard kanban vocabulary —
 * "WIP limit" — not an unresolved-content marker.)
 */
export const PLACEHOLDER_TOKENS: readonly string[] = [
  'tbd',
  'tbc',
  'todo',
  'fixme',
  'xxx',
];

export const PLACEHOLDER_PHRASES: readonly string[] = [
  'to be decided',
  'to be determined',
  'to be confirmed',
  'lorem ipsum',
  'placeholder text',
];

/**
 * Words that carry no information about *what* the work is. A summary made
 * only of these (plus stopwords) is not specific, however it is phrased.
 */
export const VAGUE_WORDS: ReadonlySet<string> = new Set([
  'fix',
  'fixes',
  'bug',
  'bugs',
  'issue',
  'issues',
  'update',
  'updates',
  'change',
  'changes',
  'stuff',
  'thing',
  'things',
  'misc',
  'miscellaneous',
  'various',
  'some',
  'general',
  'task',
  'tasks',
  'work',
  'improve',
  'improvement',
  'improvements',
  'enhancement',
  'enhancements',
  'feature',
  'features',
  'support',
  'handle',
  'handling',
  'look',
  'check',
  'test',
  'testing',
  'refactor',
  'cleanup',
  'clean',
  'code',
  'screen',
  'page',
]);

export const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'without',
  'is',
  'are',
  'be',
  'it',
  'this',
  'that',
  'as',
  'at',
  'by',
  'from',
  'into',
  'not',
  'no',
  'do',
  'does',
]);

/** Summary check tuning: minimum raw length and minimum specific tokens. */
export const SUMMARY_MIN_CHARS = 25;
export const SUMMARY_MIN_SPECIFIC_TOKENS = 3;

/** The canonical acceptance-criteria heading (the rubric reads it). */
export const ACCEPTANCE_CRITERIA_HEADING = 'Acceptance criteria';

/** Default Improve section structure (Wave 2: now per-project). */
export const DEFAULT_IMPROVE_SECTIONS: readonly string[] = [
  'Goal',
  'Context',
  ACCEPTANCE_CRITERIA_HEADING,
  'Definition of done',
];

export const DEFAULT_SETTINGS: ProjectSettings = {
  readyThreshold: 80,
  almostThreshold: 60,
  checksEnabled: {
    description: true,
    'acceptance-criteria': true,
    estimate: true,
    priority: true,
    assignee: true,
    'labels-or-components': true,
    'linked-work': true,
    'no-placeholders': true,
    'summary-quality': true,
    'due-date': true,
    'repro-steps': true,
  },
  weights: { ...CHECK_WEIGHTS },
  improveSections: [...DEFAULT_IMPROVE_SECTIONS],
  excludedIssueTypes: [],
  excludedStatuses: [],
  donePolicy: 'exclude',
  analyticsEnabled: false,
};

/** Every check id, in rubric order (settings UI + normalization). */
export const ALL_CHECK_IDS: readonly CheckId[] = [
  'description',
  'acceptance-criteria',
  'estimate',
  'priority',
  'assignee',
  'labels-or-components',
  'linked-work',
  'no-placeholders',
  'summary-quality',
  'due-date',
  'repro-steps',
];

/**
 * Checks a project may switch off in settings. Wave 2: every check is
 * toggleable (previously only estimate / due-date / repro-steps).
 */
export const TOGGLEABLE_CHECKS: readonly CheckId[] = ALL_CHECK_IDS;
