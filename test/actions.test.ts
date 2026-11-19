import { describe, expect, it } from 'vitest';
import {
  fetchCompareIssues,
  fetchFixFirst,
  fetchIssueReadiness,
  fetchProjectReadiness,
  fetchSuggestedFixes,
} from '../src/functions/actions';
import { scanProject, scoreAndStore, type ResolverDeps } from '../src/functions/resolver';
import { DEFAULT_FIELD_MAP, FakeJiraAdapter, normalizeIssue, type RawJiraIssue } from '../src/lib/jira';
import { CHECK_LABELS, DEFAULT_SETTINGS } from '../src/lib/rubric-config';
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

describe('fetchSuggestedFixes (Wave 3)', () => {
  it('returns the worst issue with every failing check and its exact projected gain', async () => {
    const { deps } = await makeSeededDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    const result = await fetchSuggestedFixes(deps, { projectKey: 'RS' });
    expect(result.found).toBe(true);
    expect(result.issueKey).toBe('RS-3');
    expect(result.score).toBe(20);
    // RS-3 fails 7 checks; the biggest single fix is description or AC (+20).
    expect(result.fixes?.length).toBe(7);
    expect(result.fixes?.[0]?.projectedGain).toBe(20);
    expect(result.fixes?.[0]?.projectedScore).toBe(40);
    const gains = result.fixes?.map((fix) => fix.projectedGain) ?? [];
    expect(gains).toEqual([...gains].sort((a, b) => b - a));
  });

  it('answers found:false for a project with nothing scored', async () => {
    const { deps } = await makeSeededDeps([]);
    const result = await fetchSuggestedFixes(deps, { projectKey: 'RS' });
    expect(result).toEqual({ found: false, projectKey: 'RS' });
  });
});

describe('fetchCompareIssues (Wave 3)', () => {
  it('explains a score gap as the checks where the two issues differ', async () => {
    const { deps } = await makeSeededDeps([makeRawIssue(), makeRawMessyIssue()]);
    const result = await fetchCompareIssues(deps, { issueKeyA: 'RS-1', issueKeyB: 'RS-3' });
    expect(result.found).toBe(true);
    expect(result.a?.score).toBe(100);
    expect(result.b?.score).toBe(20);
    const labels = result.differences?.map((diff) => diff.label) ?? [];
    expect(labels).toContain('Description is substantial');
    expect(labels).toContain('Acceptance criteria present');
    // Priority passes on both — it must NOT appear as a difference.
    expect(labels).not.toContain('Priority set');
    const description = result.differences?.find((diff) => diff.label === 'Description is substantial');
    expect(description?.aPassed).toBe(true);
    expect(description?.bPassed).toBe(false);
  });

  it('reports the missing key when either issue was never scored', async () => {
    const { deps } = await makeSeededDeps([makeRawIssue()]);
    const result = await fetchCompareIssues(deps, { issueKeyA: 'RS-1', issueKeyB: 'RS-404' });
    expect(result.found).toBe(false);
    expect(result.missing).toEqual(['RS-404']);
  });
});

describe('Coach actions stay open-only under the Done policy (B9)', () => {
  it('suggested fixes never nominate a Done issue, even when include is on', async () => {
    const done = makeRawMessyIssue('RS-4');
    done.fields.status = { name: 'Done', statusCategory: { key: 'done' } };
    // RS-4 (Done) cannot be scan-seeded — scans skip Done by design —
    // so score it the other production way: an issue event/panel path
    // stores records for Done issues opened directly. Seed it via a
    // manual record through the same store the scan uses.
    const { deps, store } = await makeSeededDeps([makeRawIssue(), makeRawIssueNoEstimate()]);
    await scoreAndStore(
      deps,
      normalizeIssue(done, DEFAULT_FIELD_MAP),
      DEFAULT_SETTINGS,
      DEFAULT_FIELD_MAP,
      'event',
    );
    await store.saveSettings('RS', { ...DEFAULT_SETTINGS, donePolicy: 'include' });
    const result = await fetchSuggestedFixes(deps, { projectKey: 'RS' });
    expect(result.found).toBe(true);
    // The worst OPEN issue is RS-2 (90); the Done RS-4 (20) must not win.
    expect(result.issueKey).toBe('RS-2');
    const fixFirst = await fetchFixFirst(deps, { projectKey: 'RS' });
    expect(fixFirst.issues.map((issue) => issue.issueKey)).not.toContain('RS-4');
  });
});

describe('fixes (2026-11-18)', () => {
  it('B20: project readiness follows donePolicy include (fix-first stays open-only, per the B9 pin)', async () => {
    const done = makeRawMessyIssue('RS-4');
    done.fields.status = { name: 'Done', statusCategory: { key: 'done' } };
    // RS-4 exists in Jira (the fake holds it) but is Done, so the
    // seeding scan does not score it; its record is stored directly,
    // as an event would have written it before it closed.
    const { deps, store } = await makeSeededDeps([makeRawIssue(), makeRawIssueNoEstimate(), done]);
    await scoreAndStore(
      deps,
      normalizeIssue(done, DEFAULT_FIELD_MAP),
      DEFAULT_SETTINGS,
      DEFAULT_FIELD_MAP,
      'event',
    );
    await store.saveSettings('RS', { ...DEFAULT_SETTINGS, donePolicy: 'include' });
    const readiness = await fetchProjectReadiness(deps, { projectKey: 'RS' });
    expect(readiness.totalScored).toBe(3);
  });

  it('B21: compare reports a check that exists on only one issue when that side fails it', async () => {
    const bug = makeRawMessyIssue('RS-4');
    bug.fields.issuetype = { name: 'Bug' };
    const { deps } = await makeSeededDeps([makeRawIssue(), bug]);
    await scoreAndStore(
      deps,
      normalizeIssue(bug, DEFAULT_FIELD_MAP),
      DEFAULT_SETTINGS,
      DEFAULT_FIELD_MAP,
      'event',
    );
    const result = await fetchCompareIssues(deps, { issueKeyA: 'RS-1', issueKeyB: 'RS-4' });
    expect(result.found).toBe(true);
    const repro = (result.differences ?? []).find(
      (diff) => diff.label === 'Steps to reproduce documented',
    );
    expect(repro).toBeDefined();
    // RS-1 is a Story: the check does not apply there — round 2
    // (F-15) reports that as null, never as a pass; the Bug fails
    // it, and that explains the gap.
    expect(repro?.aPassed).toBeNull();
    expect(repro?.bPassed).toBe(false);
  });
});
