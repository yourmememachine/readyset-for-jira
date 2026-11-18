/**
 * ReadySet readiness rubric — the heart of the app.
 *
 * Pure TypeScript: a {@link NormalizedIssue} goes in, a
 * {@link ReadinessScore} comes out. No I/O, no Forge imports, no clocks,
 * no randomness — the same issue always scores the same way, which is
 * what makes the score explainable on the issue, comparable on the
 * dashboard, and safe to cache.
 *
 * Scoring: each enabled check contributes its weight when it passes.
 * The total is renormalized over enabled checks only, so switching a
 * check off in project settings keeps the scale at 0–100.
 */
import {
  CHECK_LABELS,
  CHECK_WEIGHTS,
  DEFAULT_SETTINGS,
  DESCRIPTION_MIN_CHARS,
  DUE_DATE_PRIORITIES,
  PLACEHOLDER_PHRASES,
  PLACEHOLDER_TOKENS,
  STOPWORDS,
  SUMMARY_MIN_CHARS,
  SUMMARY_MIN_SPECIFIC_TOKENS,
  TOGGLEABLE_CHECKS,
  VAGUE_WORDS,
} from './rubric-config';
import type {
  CheckId,
  CheckResult,
  Grade,
  NormalizedIssue,
  ProjectSettings,
  ReadinessScore,
} from './types';

const PLACEHOLDER_TOKEN_RE = new RegExp(
  `\\b(${PLACEHOLDER_TOKENS.join('|')})s?\\b`,
  'i',
);
const ACCEPTANCE_CRITERIA_RE = /acceptance criteria/i;

function result(
  id: CheckId,
  passed: boolean,
  detail: string,
  fixHint: string,
): CheckResult {
  return { id, label: CHECK_LABELS[id], weight: CHECK_WEIGHTS[id], passed, detail, fixHint };
}

function checkDescription(issue: NormalizedIssue): CheckResult {
  const length = issue.descriptionText.trim().length;
  const passed = length >= DESCRIPTION_MIN_CHARS;
  return result(
    'description',
    passed,
    passed
      ? `Description is ${length} characters.`
      : length === 0
        ? 'Description is empty.'
        : `Description is only ${length} characters (needs ${DESCRIPTION_MIN_CHARS}+).`,
    'Write a real description: the goal, the context, and what "done" looks like.',
  );
}

function checkAcceptanceCriteria(issue: NormalizedIssue): CheckResult {
  const fieldText = issue.acceptanceCriteriaText?.trim() ?? '';
  if (fieldText.length >= 10) {
    return result(
      'acceptance-criteria',
      true,
      'Acceptance criteria field is filled in.',
      '',
    );
  }
  if (ACCEPTANCE_CRITERIA_RE.test(issue.descriptionText)) {
    return result(
      'acceptance-criteria',
      true,
      'Description contains an acceptance criteria section.',
      '',
    );
  }
  return result(
    'acceptance-criteria',
    false,
    'No acceptance criteria section in the description.',
    'Add an "Acceptance criteria" section listing how reviewers will verify this work.',
  );
}

function checkEstimate(issue: NormalizedIssue): CheckResult {
  if (issue.storyPoints !== null && issue.storyPoints > 0) {
    return result('estimate', true, `Story points set (${issue.storyPoints}).`, '');
  }
  if (issue.originalEstimateSeconds !== null && issue.originalEstimateSeconds > 0) {
    const hours = Math.round((issue.originalEstimateSeconds / 3600) * 10) / 10;
    return result('estimate', true, `Time estimate set (${hours}h).`, '');
  }
  return result(
    'estimate',
    false,
    'No story points or time estimate.',
    'Estimate the work (story points or time) before it enters a sprint.',
  );
}

function checkPriority(issue: NormalizedIssue): CheckResult {
  const priority = issue.priority?.trim() ?? '';
  const passed = priority.length > 0;
  return result(
    'priority',
    passed,
    passed ? `Priority is ${priority}.` : 'Priority is not set.',
    'Set a priority so the team knows how this ranks against other work.',
  );
}

function checkAssignee(issue: NormalizedIssue): CheckResult {
  const assignee = issue.assignee?.trim() ?? '';
  const passed = assignee.length > 0;
  return result(
    'assignee',
    passed,
    passed ? `Assigned to ${assignee}.` : 'Issue is unassigned.',
    'Assign an owner — unassigned work is nobody’s work.',
  );
}

function checkLabelsOrComponents(issue: NormalizedIssue): CheckResult {
  const total = issue.labels.length + issue.components.length;
  const passed = total > 0;
  const parts: string[] = [];
  if (issue.labels.length > 0) parts.push(`labels: ${issue.labels.join(', ')}`);
  if (issue.components.length > 0) parts.push(`components: ${issue.components.join(', ')}`);
  return result(
    'labels-or-components',
    passed,
    passed ? parts.join('; ') + '.' : 'No labels and no component.',
    'Add at least one label or component so the work is classifiable and routable.',
  );
}

function checkLinkedWork(issue: NormalizedIssue): CheckResult {
  if (issue.linkedIssueCount > 0) {
    return result(
      'linked-work',
      true,
      `${issue.linkedIssueCount} linked issue${issue.linkedIssueCount === 1 ? '' : 's'}.`,
      '',
    );
  }
  if (issue.parentKey) {
    return result('linked-work', true, `Has parent ${issue.parentKey}.`, '');
  }
  if (issue.epicKey) {
    return result('linked-work', true, `Belongs to epic ${issue.epicKey}.`, '');
  }
  return result(
    'linked-work',
    false,
    'No linked issues, parent, or epic.',
    'Link related work, or place the issue under its parent/epic, so dependencies are visible.',
  );
}

function findPlaceholder(text: string): string | null {
  const tokenMatch = text.match(PLACEHOLDER_TOKEN_RE);
  if (tokenMatch) return tokenMatch[0];
  const lower = text.toLowerCase();
  for (const phrase of PLACEHOLDER_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

function checkNoPlaceholders(issue: NormalizedIssue): CheckResult {
  const inSummary = findPlaceholder(issue.summary);
  if (inSummary) {
    return result(
      'no-placeholders',
      false,
      `Summary still contains the placeholder "${inSummary}".`,
      'Replace placeholder text with the real requirement before sprint planning.',
    );
  }
  const inDescription = findPlaceholder(issue.descriptionText);
  if (inDescription) {
    return result(
      'no-placeholders',
      false,
      `Description still contains the placeholder "${inDescription}".`,
      'Replace placeholder text with the real requirement before sprint planning.',
    );
  }
  return result('no-placeholders', true, 'No TBD/TODO-style placeholders found.', '');
}

function specificTokens(summary: string): string[] {
  return summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !VAGUE_WORDS.has(token) && !STOPWORDS.has(token));
}

function checkSummaryQuality(issue: NormalizedIssue): CheckResult {
  const summary = issue.summary.trim();
  if (summary.length < SUMMARY_MIN_CHARS) {
    return result(
      'summary-quality',
      false,
      `Summary is only ${summary.length} characters (needs ${SUMMARY_MIN_CHARS}+).`,
      'Write a summary that names the thing being changed and why.',
    );
  }
  const specific = specificTokens(summary);
  const passed = specific.length >= SUMMARY_MIN_SPECIFIC_TOKENS;
  return result(
    'summary-quality',
    passed,
    passed
      ? 'Summary names specific work.'
      : 'Summary is built from vague words only ("fix bug", "update stuff" style).',
    'Name the concrete system, behaviour, or user outcome — not just "fix" or "update".',
  );
}

function checkDueDate(issue: NormalizedIssue): CheckResult {
  const priority = (issue.priority ?? '').trim().toLowerCase();
  if (!DUE_DATE_PRIORITIES.has(priority)) {
    return result(
      'due-date',
      true,
      issue.priority
        ? `Due date not required at priority ${issue.priority}.`
        : 'Due date not required (no high priority set).',
      '',
    );
  }
  const passed = issue.dueDate !== null && issue.dueDate.trim() !== '';
  return result(
    'due-date',
    passed,
    passed
      ? `Due date set (${issue.dueDate}) for priority ${issue.priority}.`
      : `Priority is ${issue.priority} but no due date is set.`,
    'High-priority work needs a due date so its deadline is explicit.',
  );
}

const ALL_CHECKS: ReadonlyArray<(issue: NormalizedIssue) => CheckResult> = [
  checkDescription,
  checkAcceptanceCriteria,
  checkEstimate,
  checkPriority,
  checkAssignee,
  checkLabelsOrComponents,
  checkLinkedWork,
  checkNoPlaceholders,
  checkSummaryQuality,
  checkDueDate,
];

export function isCheckEnabled(id: CheckId, settings: ProjectSettings): boolean {
  if ((TOGGLEABLE_CHECKS as readonly string[]).includes(id)) {
    return settings.checksEnabled[id as keyof ProjectSettings['checksEnabled']];
  }
  return true;
}

export function gradeForScore(score: number, settings: ProjectSettings): Grade {
  if (score >= settings.readyThreshold) return 'ready';
  if (score >= settings.almostThreshold) return 'almost';
  return 'not-ready';
}

/**
 * Score one issue. Deterministic and side-effect free.
 */
export function scoreIssue(
  issue: NormalizedIssue,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): ReadinessScore {
  const checks = ALL_CHECKS.map((check) => check(issue)).filter((check) =>
    isCheckEnabled(check.id, settings),
  );
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = checks.reduce(
    (sum, check) => sum + (check.passed ? check.weight : 0),
    0,
  );
  const score = totalWeight === 0 ? 0 : Math.round((100 * earnedWeight) / totalWeight);
  return {
    issueKey: issue.key,
    score,
    grade: gradeForScore(score, settings),
    checks,
  };
}
