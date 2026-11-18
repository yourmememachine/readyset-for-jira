import { describe, expect, it } from 'vitest';
import { computeProjectStats } from '../src/lib/aggregate';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import type { ProjectSettings, StoredScore } from '../src/lib/types';

function record(
  issueKey: string,
  score: number,
  statusCategory = 'new',
): StoredScore {
  return {
    issueKey,
    projectKey: 'RS',
    summary: `Summary ${issueKey}`,
    statusName: statusCategory === 'done' ? 'Done' : 'To Do',
    statusCategory,
    score,
    grade: 'not-ready',
    checks: [],
    issueUpdated: '2026-11-17T10:00:00.000Z',
    computedAt: '2026-11-17T10:05:00.000Z',
    settingsFingerprint: 'fp',
  };
}

describe('computeProjectStats', () => {
  it('returns zeros for an empty project', () => {
    const stats = computeProjectStats('RS', [], DEFAULT_SETTINGS);
    expect(stats).toMatchObject({
      totalScored: 0,
      openScored: 0,
      averageScore: 0,
      percentReady: 0,
      counts: { ready: 0, almost: 0, 'not-ready': 0 },
      worstOffenders: [],
    });
  });

  it('computes average, percent ready and grade counts over open issues', () => {
    const stats = computeProjectStats(
      'RS',
      [record('RS-1', 100), record('RS-2', 90), record('RS-3', 20)],
      DEFAULT_SETTINGS,
    );
    expect(stats.openScored).toBe(3);
    expect(stats.averageScore).toBe(70);
    expect(stats.percentReady).toBe(66.7);
    expect(stats.counts).toEqual({ ready: 2, almost: 0, 'not-ready': 1 });
  });

  it('excludes done issues from open stats but counts them in totalScored', () => {
    const stats = computeProjectStats(
      'RS',
      [record('RS-1', 100), record('RS-2', 10, 'done')],
      DEFAULT_SETTINGS,
    );
    expect(stats.totalScored).toBe(2);
    expect(stats.openScored).toBe(1);
    expect(stats.averageScore).toBe(100);
    expect(stats.worstOffenders.map((candidate) => candidate.issueKey)).toEqual(['RS-1']);
  });

  it('orders worst offenders by score, ties broken by issue key, capped at the limit', () => {
    const records = [
      record('RS-9', 30),
      record('RS-2', 30),
      record('RS-5', 10),
      record('RS-1', 95),
    ];
    const stats = computeProjectStats('RS', records, DEFAULT_SETTINGS, 3);
    expect(stats.worstOffenders.map((candidate) => candidate.issueKey)).toEqual([
      'RS-5',
      'RS-2',
      'RS-9',
    ]);
  });

  it('re-buckets grades against current thresholds, including in worst offenders', () => {
    const strict: ProjectSettings = { ...DEFAULT_SETTINGS, readyThreshold: 95 };
    const stats = computeProjectStats('RS', [record('RS-1', 90)], strict);
    expect(stats.counts).toEqual({ ready: 0, almost: 1, 'not-ready': 0 });
    expect(stats.worstOffenders[0]?.grade).toBe('almost');
    expect(stats.percentReady).toBe(0);
  });
});
