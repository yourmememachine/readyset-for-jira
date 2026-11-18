import { describe, expect, it } from 'vitest';
import type { ApplyPayload, ImprovePayload } from '../src/functions/improver';
import {
  applyFailed,
  applyLoaded,
  beginApply,
  beginDraft,
  diffSections,
  discardDraft,
  draftFailed,
  draftLoaded,
  draftSourceLabel,
  formatScoreChange,
  initialImproveState,
  isStaleDraftError,
  toImproveMessage,
  type ImproveFlowState,
} from '../src/lib/improve-flow';
import { parseThresholdInput } from '../src/lib/threshold-input';
import { toUserMessage } from '../src/lib/user-error';

describe('parseThresholdInput (A17)', () => {
  it('parses plain and padded numbers', () => {
    expect(parseThresholdInput('80')).toBe(80);
    expect(parseThresholdInput(' 60 ')).toBe(60);
    expect(parseThresholdInput('0')).toBe(0);
  });

  it('rejects empty and non-numeric input instead of coercing to 0', () => {
    expect(parseThresholdInput('')).toBeNull();
    expect(parseThresholdInput('   ')).toBeNull();
    expect(parseThresholdInput('abc')).toBeNull();
    expect(parseThresholdInput('NaN')).toBeNull();
  });
});

describe('toUserMessage (B14)', () => {
  it('maps HTTP 410 to the removed-API explanation', () => {
    expect(toUserMessage(new Error('ReadySet: searchIssues failed with HTTP 410'))).toMatch(
      /no longer supports/,
    );
  });

  it('maps HTTP 403 and 429 to actionable sentences', () => {
    expect(toUserMessage(new Error('HTTP 403'))).toMatch(/permission/);
    expect(toUserMessage(new Error('HTTP 429'))).toMatch(/rate-limiting/);
  });

  it('passes the admin-gate message through verbatim', () => {
    const message = 'Only project administrators can change ReadySet settings.';
    expect(toUserMessage(new Error(message))).toBe(message);
  });

  it('falls back to a generic sentence for unknown errors', () => {
    expect(toUserMessage(new Error('boom'))).toMatch(/Something went wrong/);
    expect(toUserMessage('string failure')).toMatch(/Something went wrong/);
  });
});

const DRAFT: ImprovePayload = {
  issueKey: 'RS-1',
  canApply: true,
  contentHash: 'hash-1',
  source: 'llm',
  fromCache: false,
  sections: [{ heading: 'Goal', paragraphs: ['Ship it.'] }],
  currentSections: [],
  mode: 'full',
  currentScore: 20,
  projectedScore: 60,
};

const APPLIED: ApplyPayload = {
  issueKey: 'RS-1',
  previousScore: 20,
  newScore: 60,
  source: 'llm',
};

function reviewState(): ImproveFlowState {
  return draftLoaded(beginDraft(initialImproveState), DRAFT);
}

describe('improve flow state transitions', () => {
  it('walks idle → drafting → review → applying → applied', () => {
    const drafting = beginDraft(initialImproveState);
    expect(drafting.phase).toBe('drafting');

    const review = draftLoaded(drafting, DRAFT);
    expect(review.phase).toBe('review');
    expect(review.draft).toBe(DRAFT);

    const applying = beginApply(review);
    expect(applying.phase).toBe('applying');
    expect(applying.draft).toBe(DRAFT);

    const applied = applyLoaded(applying, APPLIED);
    expect(applied.phase).toBe('applied');
    expect(applied.applied).toBe(APPLIED);
    expect(applied.draft).toBeNull();
  });

  it('discards a draft from review back to idle', () => {
    expect(discardDraft(reviewState())).toEqual(initialImproveState);
  });

  it('ignores transitions from the wrong phase', () => {
    // No draft is in flight yet: Apply and draft-arrival are no-ops.
    expect(beginApply(initialImproveState)).toBe(initialImproveState);
    expect(draftLoaded(initialImproveState, DRAFT)).toBe(initialImproveState);
    // A second Improve click while drafting does not restart the flow.
    const drafting = beginDraft(initialImproveState);
    expect(beginDraft(drafting)).toBe(drafting);
    // Discard is not offered while a draft is being generated.
    expect(discardDraft(drafting)).toBe(drafting);
  });

  it('can improve again from the applied and error phases', () => {
    const applied = applyLoaded(beginApply(reviewState()), APPLIED);
    expect(beginDraft(applied).phase).toBe('drafting');

    const failed = draftFailed(beginDraft(initialImproveState), new Error('boom'));
    expect(failed.phase).toBe('error');
    expect(beginDraft(failed).phase).toBe('drafting');
    expect(discardDraft(failed)).toEqual(initialImproveState);
  });

  it('a failed draft lands in the error phase with a mapped message', () => {
    const failed = draftFailed(beginDraft(initialImproveState), new Error('HTTP 429'));
    expect(failed.phase).toBe('error');
    expect(failed.draft).toBeNull();
    expect(failed.message).toMatch(/rate-limiting/);
  });
});

describe('improve flow apply failures', () => {
  const STALE = new Error(
    'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
  );
  const MISSING = new Error('The draft for this issue is no longer available. Run Improve again.');

  it('recognises both stale-draft refusals', () => {
    expect(isStaleDraftError(STALE)).toBe(true);
    expect(isStaleDraftError(MISSING)).toBe(true);
    expect(isStaleDraftError(new Error('HTTP 500'))).toBe(false);
  });

  it('a stale refusal clears the draft and lands in the error phase', () => {
    const failed = applyFailed(beginApply(reviewState()), STALE);
    expect(failed.phase).toBe('error');
    expect(failed.draft).toBeNull();
    expect(failed.message).toMatch(/changed since the draft was created/);
  });

  it('a transient failure returns to review with the draft intact for a retry', () => {
    const failed = applyFailed(beginApply(reviewState()), new Error('HTTP 429'));
    expect(failed.phase).toBe('review');
    expect(failed.draft).toBe(DRAFT);
    expect(failed.message).toMatch(/rate-limiting/);
  });
});

describe('toImproveMessage', () => {
  it('rewrites the stale-draft refusals as instructions', () => {
    expect(
      toImproveMessage(new Error('This issue changed since the draft was generated.')),
    ).toMatch(/Run Improve again/);
    expect(toImproveMessage(new Error('The draft for this issue is no longer available.'))).toMatch(
      /no longer available/,
    );
  });

  it('delegates HTTP failures to the shared resolver mapping', () => {
    expect(toImproveMessage(new Error('ReadySet: update failed with HTTP 403'))).toMatch(
      /permission/,
    );
    expect(toImproveMessage(new Error('HTTP 404'))).toMatch(/could not find/);
  });

  it('uses an Improve-specific fallback instead of the data-loading one', () => {
    const message = toImproveMessage(new Error('boom'));
    expect(message).toMatch(/Something went wrong with Improve/);
    expect(message).not.toMatch(/loading ReadySet data/);
  });
});

describe('improve flow display helpers', () => {
  it('formats the projected score change with its delta', () => {
    expect(formatScoreChange(20, 60)).toBe('20 → 60 (+40)');
    expect(formatScoreChange(60, 40)).toBe('60 → 40 (-20)');
    expect(formatScoreChange(50, 50)).toBe('50 → 50 (no change)');
  });

  it('labels where the draft came from', () => {
    expect(draftSourceLabel('llm')).toMatch(/AI-drafted/);
    expect(draftSourceLabel('template')).toMatch(/Template draft/);
  });
});

describe('diffSections (Wave 3 diff view)', () => {
  const current = [
    { heading: 'Goal', paragraphs: ['Ship it.'] },
    { heading: 'Notes', paragraphs: ['Old note.'] },
  ];

  it('marks added, changed, same, and removed sections', () => {
    const draft = [
      { heading: 'Goal', paragraphs: ['Ship it.'] },
      { heading: 'Notes', paragraphs: ['New note.'] },
      { heading: 'Acceptance criteria', paragraphs: ['It works.'] },
    ];
    expect(diffSections(current, draft)).toEqual([
      { heading: 'Goal', status: 'same' },
      { heading: 'Notes', status: 'changed' },
      { heading: 'Acceptance criteria', status: 'added' },
    ]);
    const shrinking = [{ heading: 'Goal', paragraphs: ['Ship it.'] }];
    expect(diffSections(current, shrinking)).toEqual([
      { heading: 'Goal', status: 'same' },
      { heading: 'Notes', status: 'removed' },
    ]);
  });

  it('matches headings case-insensitively and ignores the unheaded intro in removals', () => {
    const withIntro = [{ heading: '', paragraphs: ['Loose text.'] }, ...current];
    const draft = [{ heading: 'goal', paragraphs: ['Ship it.'] }];
    expect(diffSections(withIntro, draft)).toEqual([
      { heading: 'goal', status: 'same' },
      { heading: 'Notes', status: 'removed' },
    ]);
  });
});

describe('war-room frontend fixes (2026-11-18)', () => {
  it('C4: the summary not-enough-text refusal passes through verbatim instead of a retry offer', () => {
    const message = toImproveMessage(
      new Error(
        'There is not enough text in this issue to suggest a better summary. Add a description first.',
      ),
    );
    expect(message).toMatch(/not enough text/);
    expect(message).toMatch(/Add a description first/);
    expect(message).not.toMatch(/Something went wrong/);
  });

  it('B1: a post-write warning rides on the applied state as its message', () => {
    const applied = applyLoaded(beginApply(reviewState()), {
      ...APPLIED,
      postWriteWarning: 'The description was updated, but the audit comment could not be posted.',
    });
    expect(applied.phase).toBe('applied');
    expect(applied.message).toMatch(/audit comment/);
  });
});
