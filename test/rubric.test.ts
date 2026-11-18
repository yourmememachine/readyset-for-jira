import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import { gradeForScore, scoreIssue } from '../src/lib/rubric';
import type { CheckId, ProjectSettings } from '../src/lib/types';
import { LONG_DESCRIPTION, makeEmptyIssue, makeIssue } from './fixtures';

function check(score: ReturnType<typeof scoreIssue>, id: CheckId) {
  const found = score.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`check ${id} missing from result`);
  return found;
}

function settings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    checksEnabled: { ...DEFAULT_SETTINGS.checksEnabled, ...(overrides.checksEnabled ?? {}) },
  };
}

describe('scoreIssue — headline cases', () => {
  it('scores a fully specified issue at exactly 100, grade ready, all checks passing', () => {
    const result = scoreIssue(makeIssue());
    expect(result.score).toBe(100);
    expect(result.grade).toBe('ready');
    expect(result.checks).toHaveLength(10);
    expect(result.checks.every((candidate) => candidate.passed)).toBe(true);
  });

  it('scores an empty issue at 15 (only the two vacuous checks pass)', () => {
    const result = scoreIssue(makeEmptyIssue());
    expect(result.score).toBe(15);
    expect(result.grade).toBe('not-ready');
    expect(check(result, 'description').passed).toBe(false);
    expect(check(result, 'acceptance-criteria').passed).toBe(false);
    expect(check(result, 'estimate').passed).toBe(false);
    expect(check(result, 'priority').passed).toBe(false);
    expect(check(result, 'assignee').passed).toBe(false);
    expect(check(result, 'labels-or-components').passed).toBe(false);
    expect(check(result, 'linked-work').passed).toBe(false);
    expect(check(result, 'summary-quality').passed).toBe(false);
    // Nothing written yet -> nothing can contain a placeholder, and a due
    // date is not required without a high priority. Both pass vacuously.
    expect(check(result, 'no-placeholders').passed).toBe(true);
    expect(check(result, 'due-date').passed).toBe(true);
  });

  it('is deterministic: the same issue scores identically twice', () => {
    const issue = makeIssue({ storyPoints: null, labels: [] });
    expect(scoreIssue(issue)).toEqual(scoreIssue(issue));
  });
});

describe('description check', () => {
  // Acceptance criteria are supplied via the dedicated field in these
  // tests so the description check is measured in isolation.
  const AC_FIELD =
    'Given a valid API key, when the quota is exceeded, then the gateway returns 429.';

  it('passes at exactly 280 characters and fails at 279', () => {
    const at = scoreIssue(
      makeIssue({ descriptionText: 'x'.repeat(280), acceptanceCriteriaText: AC_FIELD }),
    );
    expect(check(at, 'description').passed).toBe(true);
    const below = scoreIssue(
      makeIssue({ descriptionText: 'x'.repeat(279), acceptanceCriteriaText: AC_FIELD }),
    );
    expect(check(below, 'description').passed).toBe(false);
    expect(below.score).toBe(80);
  });

  it('ignores surrounding whitespace when measuring length', () => {
    const result = scoreIssue(
      makeIssue({ descriptionText: `   ${'x'.repeat(279)}   ` }),
    );
    expect(check(result, 'description').passed).toBe(false);
  });
});

describe('acceptance criteria check', () => {
  it('passes via a section in the description', () => {
    const result = scoreIssue(makeIssue());
    expect(check(result, 'acceptance-criteria').passed).toBe(true);
  });

  it('passes via a dedicated field even without a description section', () => {
    const result = scoreIssue(
      makeIssue({
        descriptionText: 'y'.repeat(300),
        acceptanceCriteriaText: 'Given a valid API key, when the quota is exceeded, then the gateway returns 429.',
      }),
    );
    expect(check(result, 'acceptance-criteria').passed).toBe(true);
  });

  it('fails when the field holds only a token amount of text', () => {
    const result = scoreIssue(
      makeIssue({ descriptionText: 'y'.repeat(300), acceptanceCriteriaText: 'ok' }),
    );
    expect(check(result, 'acceptance-criteria').passed).toBe(false);
  });
});

describe('estimate check', () => {
  it('fails when no estimate is set (score 90)', () => {
    const result = scoreIssue(makeIssue({ storyPoints: null, originalEstimateSeconds: null }));
    expect(check(result, 'estimate').passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it('passes on a time estimate alone', () => {
    const result = scoreIssue(makeIssue({ storyPoints: null, originalEstimateSeconds: 7200 }));
    expect(check(result, 'estimate').passed).toBe(true);
  });

  it('treats zero story points as unset', () => {
    const result = scoreIssue(makeIssue({ storyPoints: 0 }));
    expect(check(result, 'estimate').passed).toBe(false);
  });
});

describe('linked work check', () => {
  it('fails with no links, parent, or epic (score 90)', () => {
    const result = scoreIssue(makeIssue({ linkedIssueCount: 0 }));
    expect(check(result, 'linked-work').passed).toBe(false);
    expect(result.score).toBe(90);
  });

  it('passes on a parent alone', () => {
    const result = scoreIssue(makeIssue({ linkedIssueCount: 0, parentKey: 'RS-10' }));
    expect(check(result, 'linked-work').passed).toBe(true);
  });

  it('passes on an epic alone', () => {
    const result = scoreIssue(makeIssue({ linkedIssueCount: 0, epicKey: 'RS-20' }));
    expect(check(result, 'linked-work').passed).toBe(true);
  });
});

describe('placeholder check', () => {
  it('fails on TBD in the description', () => {
    const result = scoreIssue(
      makeIssue({ descriptionText: `${LONG_DESCRIPTION}\n\nOwner: TBD` }),
    );
    const placeholderCheck = check(result, 'no-placeholders');
    expect(placeholderCheck.passed).toBe(false);
    expect(placeholderCheck.detail).toContain('TBD');
    expect(result.score).toBe(90);
  });

  it('fails on a TODO marker in the summary', () => {
    const result = scoreIssue(
      makeIssue({ summary: 'TODO: wire up the gateway rate limiter properly' }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(false);
  });

  it('fails on the phrase "to be decided"', () => {
    const result = scoreIssue(
      makeIssue({ descriptionText: `${LONG_DESCRIPTION}\n\nRollout date to be decided.` }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(false);
  });

  it('does not false-positive on words that merely contain a marker', () => {
    const result = scoreIssue(
      makeIssue({ summary: 'Integrate Todoist sync for gateway quota alerts' }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(true);
  });

  it('does not flag standard kanban vocabulary ("WIP limit")', () => {
    const result = scoreIssue(
      makeIssue({
        descriptionText: `${LONG_DESCRIPTION}\n\nThis also lowers the WIP limit on the review column from six to four.`,
      }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(true);
  });
});

describe('summary quality check', () => {
  it('fails on a short vague summary', () => {
    const result = scoreIssue(makeIssue({ summary: 'Fix bug' }));
    expect(check(result, 'summary-quality').passed).toBe(false);
  });

  it('fails on a long summary built only from vague words', () => {
    const result = scoreIssue(makeIssue({ summary: 'Update the thing for stuff' }));
    expect(check(result, 'summary-quality').passed).toBe(false);
  });

  it('passes on a specific summary', () => {
    const result = scoreIssue(
      makeIssue({ summary: 'Improve login page performance for Safari users' }),
    );
    expect(check(result, 'summary-quality').passed).toBe(true);
  });
});

describe('due date check', () => {
  it('fails for Highest priority without a due date (score 95)', () => {
    const result = scoreIssue(makeIssue({ priority: 'Highest', dueDate: null }));
    expect(check(result, 'due-date').passed).toBe(false);
    expect(result.score).toBe(95);
  });

  it('passes for High priority with a due date', () => {
    const result = scoreIssue(makeIssue({ priority: 'High', dueDate: '2026-12-01' }));
    expect(check(result, 'due-date').passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it('is not applicable at Medium priority', () => {
    const result = scoreIssue(makeIssue({ priority: 'Medium', dueDate: null }));
    expect(check(result, 'due-date').passed).toBe(true);
  });
});

describe('labels/components and ownership checks', () => {
  it('passes labels-or-components on components alone', () => {
    const result = scoreIssue(makeIssue({ labels: [], components: ['Gateway'] }));
    expect(check(result, 'labels-or-components').passed).toBe(true);
  });

  it('fails priority when unset, while due-date stays not-applicable', () => {
    const result = scoreIssue(makeIssue({ priority: null }));
    expect(check(result, 'priority').passed).toBe(false);
    expect(check(result, 'due-date').passed).toBe(true);
    expect(result.score).toBe(95);
  });
});

describe('cross-review round 3 — rubric regressions', () => {
  it('A5: a bare "acceptance criteria" mention mid-sentence is not a section', () => {
    const result = scoreIssue(
      makeIssue({
        descriptionText:
          'We discussed the acceptance criteria with the team last week and everyone agrees they matter a lot for this rollout.',
      }),
    );
    expect(check(result, 'acceptance-criteria').passed).toBe(false);
  });

  it('A5: an "Acceptance criteria: TBD" heading with no real body fails', () => {
    const result = scoreIssue(makeIssue({ descriptionText: 'Acceptance criteria: TBD' }));
    expect(check(result, 'acceptance-criteria').passed).toBe(false);
  });

  it('A5: a real acceptance criteria section still passes', () => {
    const result = scoreIssue(
      makeIssue({
        descriptionText:
          'Some context first.\n\nAcceptance criteria:\n- Returns 429 when the limit is exceeded.\n- Retry-After header is set.',
      }),
    );
    expect(check(result, 'acceptance-criteria').passed).toBe(true);
  });

  it('A12: placeholder text in the dedicated AC field fails no-placeholders', () => {
    const result = scoreIssue(
      makeIssue({ acceptanceCriteriaText: 'TBD — write these later' }),
    );
    const placeholderCheck = check(result, 'no-placeholders');
    expect(placeholderCheck.passed).toBe(false);
    expect(placeholderCheck.detail).toContain('Acceptance criteria field');
  });

  it('A13: "todo" as product vocabulary does not trip the placeholder check', () => {
    const result = scoreIssue(
      makeIssue({ summary: 'Add todo list sharing to the mobile app' }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(true);
  });

  it('A14: "Owner: TBC" fails the placeholder check', () => {
    const result = scoreIssue(makeIssue({ descriptionText: 'Owner: TBC' }));
    expect(check(result, 'no-placeholders').passed).toBe(false);
  });

  it('A14: hyphenated "to-do" is detected as a marker', () => {
    const result = scoreIssue(
      makeIssue({ descriptionText: 'Still to-do: write the migration' }),
    );
    expect(check(result, 'no-placeholders').passed).toBe(false);
  });

  it('A15: repeating one specific token does not fake summary specificity', () => {
    const result = scoreIssue(makeIssue({ summary: 'Cache cache cache cache' }));
    expect(check(result, 'summary-quality').passed).toBe(false);
  });
});

describe('settings: toggles and thresholds', () => {
  it('renormalizes to 100 when the only failing check is disabled', () => {
    const issue = makeIssue({ storyPoints: null, originalEstimateSeconds: null });
    const result = scoreIssue(issue, settings({ checksEnabled: { estimate: false, 'due-date': true } }));
    expect(result.score).toBe(100);
    expect(result.checks.find((candidate) => candidate.id === 'estimate')).toBeUndefined();
    expect(result.checks).toHaveLength(9);
  });

  it('renormalizes the due-date check the same way', () => {
    const issue = makeIssue({ priority: 'Highest', dueDate: null });
    const result = scoreIssue(issue, settings({ checksEnabled: { estimate: true, 'due-date': false } }));
    expect(result.score).toBe(100);
  });

  it('applies custom grade thresholds', () => {
    const issue = makeIssue({ storyPoints: null, originalEstimateSeconds: null }); // scores 90
    expect(scoreIssue(issue, settings({ readyThreshold: 95 })).grade).toBe('almost');
    expect(
      scoreIssue(issue, settings({ readyThreshold: 95, almostThreshold: 92 })).grade,
    ).toBe('not-ready');
  });

  it('gradeForScore respects boundary values', () => {
    expect(gradeForScore(80, DEFAULT_SETTINGS)).toBe('ready');
    expect(gradeForScore(79, DEFAULT_SETTINGS)).toBe('almost');
    expect(gradeForScore(60, DEFAULT_SETTINGS)).toBe('almost');
    expect(gradeForScore(59, DEFAULT_SETTINGS)).toBe('not-ready');
  });
});
