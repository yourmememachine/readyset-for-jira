import { describe, expect, it } from 'vitest';
import {
  fetchFixFirst,
  fetchIssueReadiness,
  fetchProjectReadiness,
} from '../src/functions/actions';
import { scanProject, type ResolverDeps } from '../src/functions/resolver';
import { FakeJiraAdapter, type RawJiraIssue } from '../src/lib/jira';
import { CHECK_LABELS } from '../src/lib/rubric-config';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import { makeRawIssue, makeRawIssueNoEstimate, makeRawMessyIssue } from './fixtures';

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

/**
 * Seed the store the way production does: a real project scan over
 * the fake adapter. Scores: RS-1 = 100, RS-2 = 90, RS-3 = 20.
 */
async function makeSeededDeps(issues: RawJiraIssue[]) {
  const store = new ScoreStore(new InMemoryKV());
  const jira = new FakeJiraAdapter(issues);
  const deps: ResolverDeps = { jira, store, now: () => FIXED_NOW };
  await scanProject(deps, 'RS', { resume: false });
  return { deps, store };
}

describe('fetchIssueReadiness', () => {
  it('explains a scored issue check by check', async () => {
    const { deps } = await makeSeededDeps([makeRawMessyIssue()]);
    const result = await fetchIssueReadiness(deps, { issueKey: 'RS-3' });
    expect(result.found).toBe(true);
    expect(result.score).toBe(20);
    expect(result.grade).toBe('not-ready');
    expect(result.projectKey).toBe('RS');
    expect(result.checks).toHaveLength(10);
    const description = result.checks?.find((check) => check.id === 'description');
    expect(description?.passed).toBe(false);
    expect(description?.fixHint).toContain('Write a real description');
    const priority = result.checks?.find((check) => check.id === 'priority');
    expect(priority?.passed).toBe(true);
  });

  it('answers found:false for an issue that was never scored', async () => {
    const { deps } = await makeSeededDeps([makeRawIssue()]);
    const result = await fetchIssueReadiness(deps, { issueKey: 'RS-404' });
    expect(result).toEqual({ found: false, issueKey: 'RS-404' });
  });
});

describe('fetchProjectReadiness', () => {
  it('aggregates the seeded project (hand-computed)', async () => {
    const { deps } = await makeSeededDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    const result = await fetchProjectReadiness(deps, { projectKey: 'RS' });
    expect(result.scored).toBe(true);
    expect(result.totalScored).toBe(3);
    expect(result.openScored).toBe(3);
    // (100 + 90 + 20) / 3 = 70; two of three are Ready (100, 90).
    expect(result.averageScore).toBe(70);
    expect(result.percentReady).toBe(66.7);
    expect(result.counts).toEqual({ ready: 2, almost: 0, 'not-ready': 1 });
    expect(result.scanStatus).toBe('complete');
    expect(result.worstOffenders[0]?.issueKey).toBe('RS-3');
    expect(result.worstOffenders[0]?.score).toBe(20);
  });

  it('reports an unscored project honestly', async () => {
    const store = new ScoreStore(new InMemoryKV());
    const deps: ResolverDeps = {
      jira: new FakeJiraAdapter([]),
      store,
      now: () => FIXED_NOW,
    };
    const result = await fetchProjectReadiness(deps, { projectKey: 'ZZ' });
    expect(result.scored).toBe(false);
    expect(result.totalScored).toBe(0);
    expect(result.averageScore).toBe(0);
    expect(result.scanStatus).toBe('unknown');
    expect(result.worstOffenders).toEqual([]);
  });
});

describe('fetchFixFirst', () => {
  it('ranks worst first, each with its highest-weight fixes', async () => {
    const { deps } = await makeSeededDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    const result = await fetchFixFirst(deps, { projectKey: 'RS' });
    expect(result.issues.map((issue) => issue.issueKey)).toEqual(['RS-3', 'RS-2', 'RS-1']);
    const worst = result.issues[0];
    expect(worst?.score).toBe(20);
    // RS-3's failing weights: description 20, acceptance criteria 20,
    // then the 10-weight checks in rubric order — estimate first.
    expect(worst?.topFixes.map((fix) => fix.weight)).toEqual([20, 20, 10]);
    expect(worst?.topFixes.map((fix) => fix.label)).toEqual([
      CHECK_LABELS.description,
      CHECK_LABELS['acceptance-criteria'],
      CHECK_LABELS.estimate,
    ]);
    expect(worst?.topFixes[0]?.fixHint).toContain('Write a real description');
    // A perfect issue has nothing to fix.
    expect(result.issues[2]?.topFixes).toEqual([]);
  });

  it('honours the limit and clamps out-of-range values', async () => {
    const { deps } = await makeSeededDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    const one = await fetchFixFirst(deps, { projectKey: 'RS', limit: 1 });
    expect(one.issues).toHaveLength(1);
    const clamped = await fetchFixFirst(deps, { projectKey: 'RS', limit: 500 });
    expect(clamped.issues).toHaveLength(3);
  });
});
