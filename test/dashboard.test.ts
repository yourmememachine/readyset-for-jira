import { describe, expect, it } from 'vitest';
import { computeProjectStats } from '../src/lib/aggregate';
import { filterOffenders, offenderFilterOptions, UNASSIGNED } from '../src/lib/dashboard-filters';
import { scoreFeedbackHref } from '../src/lib/feedback';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import type { StoredScore } from '../src/lib/types';

function record(overrides: Partial<StoredScore>): StoredScore {
  return {
    issueKey: 'RS-1',
    score: 50,
    grade: 'not-ready',
    checks: [],
    projectKey: 'RS',
    summary: 'Something',
    statusName: 'To Do',
    statusCategory: 'new',
    issueUpdated: '2026-11-17T00:00:00.000Z',
    computedAt: '2026-11-17T00:00:00.000Z',
    settingsFingerprint: 'fp',
    ...overrides,
  };
}

const NOW = new Date('2026-11-17T12:00:00.000Z');

describe('becameReadyLast7Days (Wave 2)', () => {
  it('counts transitions into Ready inside the window, once per issue', () => {
    const stats = computeProjectStats(
      'RS',
      [
        record({
          issueKey: 'RS-1',
          score: 90,
          history: [
            { score: 20, grade: 'not-ready', at: '2026-11-15T00:00:00.000Z' },
            { score: 90, grade: 'ready', at: '2026-11-16T00:00:00.000Z' },
          ],
        }),
        record({
          issueKey: 'RS-2',
          score: 95,
          history: [{ score: 95, grade: 'ready', at: '2026-11-16T00:00:00.000Z' }],
        }),
        record({
          issueKey: 'RS-3',
          score: 88,
          history: [
            { score: 30, grade: 'not-ready', at: '2026-11-01T00:00:00.000Z' },
            { score: 88, grade: 'ready', at: '2026-11-02T00:00:00.000Z' },
          ],
        }),
      ],
      DEFAULT_SETTINGS,
      25,
      NOW,
    );
    // RS-1 transitioned 1 day ago (counts); RS-2 was first seen Ready
    // (no transition — does not count); RS-3 transitioned 15 days ago
    // (outside the window).
    expect(stats.becameReadyLast7Days).toEqual({ count: 1, total: 3, percent: 33.3 });
  });

  it('counts a transition the history cap evicted, via the durable stamp (A7)', () => {
    const stats = computeProjectStats(
      'RS',
      [
        record({
          issueKey: 'RS-9',
          score: 95,
          lastBecameReadyAt: '2026-11-16T00:00:00.000Z',
          history: [{ score: 95, grade: 'ready', at: '2026-11-16T00:00:00.000Z' }],
        }),
      ],
      DEFAULT_SETTINGS,
      25,
      NOW,
    );
    expect(stats.becameReadyLast7Days.count).toBe(1);
  });
});

describe('offender filters (Wave 2)', () => {
  const records = [
    record({ issueKey: 'RS-1', issueType: 'Bug', assignee: null, labels: ['backend'] }),
    record({ issueKey: 'RS-2', issueType: 'Story', assignee: 'Dilip Teneti', labels: [] }),
    record({ issueKey: 'RS-3', issueType: 'Bug', assignee: 'Dilip Teneti', labels: ['backend', 'api'] }),
  ];

  it('filters by type, assignee (incl. unassigned), and label', () => {
    expect(filterOffenders(records, { issueType: 'Bug' }).map((r) => r.issueKey)).toEqual(['RS-1', 'RS-3']);
    expect(filterOffenders(records, { assignee: UNASSIGNED }).map((r) => r.issueKey)).toEqual(['RS-1']);
    expect(filterOffenders(records, { label: 'api' }).map((r) => r.issueKey)).toEqual(['RS-3']);
    expect(
      filterOffenders(records, { issueType: 'Bug', assignee: 'Dilip Teneti' }).map((r) => r.issueKey),
    ).toEqual(['RS-3']);
  });

  it('derives sorted unique options from the records', () => {
    expect(offenderFilterOptions(records)).toEqual({
      issueTypes: ['Bug', 'Story'],
      assignees: [UNASSIGNED, 'Dilip Teneti'],
      labels: ['api', 'backend'],
    });
  });
});

describe('score feedback link (Wave 2)', () => {
  it('builds a prefilled mailto with issue, score and grade', () => {
    const href = scoreFeedbackHref('RS-3', 20, 'not-ready');
    expect(href.startsWith('mailto:tdilip2501@gmail.com?')).toBe(true);
    expect(decodeURIComponent(href)).toContain('RS-3');
    expect(decodeURIComponent(href)).toContain('20 (Not ready)');
  });
});
