import { describe, expect, it } from 'vitest';
import {
  getIssuePanel,
  getProjectDashboard,
  saveSettings,
  scanProject,
  type ResolverDeps,
} from '../src/functions/resolver';
import { FakeJiraAdapter, type RawJiraIssue } from '../src/lib/jira';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import { makeRawIssue, makeRawMessyIssue } from './fixtures';

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

function makeDeps(issues: RawJiraIssue[]) {
  const store = new ScoreStore(new InMemoryKV());
  const jira = new FakeJiraAdapter(issues);
  const deps: ResolverDeps = { jira, store, now: () => FIXED_NOW };
  return { deps, jira, store };
}

function doneIssue(key: string): RawJiraIssue {
  const raw = makeRawMessyIssue(key);
  raw.fields.status = { name: 'Done', statusCategory: { key: 'done' } };
  return raw;
}

describe('exclusions (Wave 3)', () => {
  it('an excluded status is never scored: panel says so and no record is kept', async () => {
    const { deps, store } = makeDeps([makeRawMessyIssue('RS-3'), doneIssue('RS-4')]);
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, excludedStatuses: ['Done'] },
    });
    const panel = await getIssuePanel(deps, { issueKey: 'RS-4' });
    expect(panel.excluded).toBe(true);
    expect(await store.getScore('RS-4')).toBeUndefined();
    // The non-excluded issue scores normally.
    const scored = await getIssuePanel(deps, { issueKey: 'RS-3' });
    expect(scored.excluded).toBeUndefined();
    expect(scored.score).toBe(20);
  });

  it('exclusions match types case-insensitively and remove previously stored records', async () => {
    const bug = makeRawMessyIssue('RS-5');
    bug.fields.issuetype = { name: 'Bug' };
    const { deps, store } = makeDeps([bug]);
    await scanProject(deps, 'RS', { resume: false });
    expect((await store.getScore('RS-5'))?.score).toBe(18);
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, excludedIssueTypes: ['bug'] },
    });
    const panel = await getIssuePanel(deps, { issueKey: 'RS-5' });
    expect(panel.excluded).toBe(true);
    expect(await store.getScore('RS-5')).toBeUndefined();
  });
});

describe('Done policy (Wave 3)', () => {
  it('exclude (default) keeps Done issues out of the stats; include counts them', async () => {
    const { deps } = makeDeps([makeRawIssue(), doneIssue('RS-4')]);
    // Scans skip Done issues by design; a Done record exists once the
    // issue itself is opened (the panel scores it directly).
    await getIssuePanel(deps, { issueKey: 'RS-4' });
    const excluded = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(excluded.stats.openScored).toBe(1);
    expect(excluded.stats.totalScored).toBe(2);
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, donePolicy: 'include' },
    });
    const included = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(included.stats.openScored).toBe(2);
    expect(included.stats.counts['not-ready']).toBe(1);
  });
});

describe('analytics counters (Wave 3)', () => {
  it('counts scores only when enabled, and the dashboard reports the totals', async () => {
    const { deps, store } = makeDeps([makeRawMessyIssue('RS-3'), makeRawMessyIssue('RS-4')]);
    await getIssuePanel(deps, { issueKey: 'RS-3' });
    expect(await store.getAnalyticsTotals('RS', 7, FIXED_NOW)).toEqual({
      scores: 0,
      drafts: 0,
      applies: 0,
    });
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, analyticsEnabled: true },
    });
    await getIssuePanel(deps, { issueKey: 'RS-4' });
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.analytics?.scores).toBeGreaterThanOrEqual(1);
    expect(dashboard.analytics?.drafts).toBe(0);
    expect(dashboard.analytics?.applies).toBe(0);
  });

  it('the dashboard omits analytics entirely when disabled', async () => {
    const { deps } = makeDeps([makeRawMessyIssue('RS-3')]);
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.analytics).toBeUndefined();
  });
});
