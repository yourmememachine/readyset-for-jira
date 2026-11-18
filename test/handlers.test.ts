import { describe, expect, it } from 'vitest';
import { handleIssueEvent, type JiraIssueEvent } from '../src/functions/events';
import { handleScheduledRescan } from '../src/functions/rescan';
import {
  continueScanProject,
  getIssuePanel,
  getProjectDashboard,
  getSettings,
  rescanProject,
  saveSettings,
  scanProject,
  type ResolverDeps,
} from '../src/functions/resolver';
import {
  FakeJiraAdapter,
  normalizeIssue,
  type JiraFieldInfo,
  type RawJiraIssue,
  type SearchPage,
} from '../src/lib/jira';
import { DEFAULT_SETTINGS } from '../src/lib/rubric-config';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import type { ProjectSettings } from '../src/lib/types';
import { makeRawIssue, makeRawIssueNoEstimate, makeRawMessyIssue } from './fixtures';

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

function makeDeps(issues: RawJiraIssue[]) {
  const kv = new InMemoryKV();
  const store = new ScoreStore(kv);
  const jira = new FakeJiraAdapter(issues);
  const deps: ResolverDeps = { jira, store, now: () => FIXED_NOW };
  return { deps, jira, store, kv };
}

function makeDepsWithJira(jira: FakeJiraAdapter) {
  const kv = new InMemoryKV();
  const store = new ScoreStore(kv);
  const deps: ResolverDeps = { jira, store, now: () => FIXED_NOW };
  return { deps, jira, store, kv };
}

/**
 * Build a real v2-shaped product-event payload from a REST-shaped raw
 * issue: custom fields move OUT of `fields` into the top-level
 * `customFields` map, exactly as Forge delivers them (cross-review B5).
 */
function v2Event(raw: RawJiraIssue, eventType = 'avi:jira:updated:issue'): JiraIssueEvent {
  const customFields: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.fields)) {
    if (key.startsWith('customfield_')) customFields[key] = value;
    else fields[key] = value;
  }
  return {
    eventType,
    issue: { key: raw.key, fields: fields as RawJiraIssue['fields'] },
    customFields,
    customFieldsStatus: 'INCLUDED',
  };
}

describe('normalizeIssue', () => {
  it('converts a raw REST issue into the flat scoring shape', () => {
    const normalized = normalizeIssue(makeRawIssue({ customfield_10014: 'RS-100' }));
    expect(normalized.key).toBe('RS-1');
    expect(normalized.projectKey).toBe('RS');
    expect(normalized.descriptionText).toContain('Acceptance criteria');
    expect(normalized.storyPoints).toBe(3);
    expect(normalized.epicKey).toBe('RS-100');
    expect(normalized.linkedIssueCount).toBe(1);
    expect(normalized.statusCategory).toBe('new');
  });
});

describe('getIssuePanel', () => {
  it('scores an issue and serves the second read from cache', async () => {
    const { deps, jira } = makeDeps([makeRawIssue()]);
    const first = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(first.score).toBe(100);
    expect(first.grade).toBe('ready');
    expect(first.fromCache).toBe(false);
    expect(first.computedAt).toBe(FIXED_NOW.toISOString());

    const second = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(second.fromCache).toBe(true);
    expect(second.score).toBe(100);
    // The issue is still fetched (its `updated` is the freshness key),
    // but no rescore happens while it is unchanged.
    expect(jira.getIssueCalls).toHaveLength(2);
  });

  it('rescores when the issue changes', async () => {
    const raws = [makeRawIssue()];
    const { deps } = makeDeps(raws);
    await getIssuePanel(deps, { issueKey: 'RS-1' });
    const fields = raws[0]?.fields;
    if (!fields) throw new Error('fixture missing');
    fields.updated = '2026-11-17T13:00:00.000Z';
    const after = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(after.fromCache).toBe(false);
  });

  it('A21: rescoring after a settings change produces the NEW score value', async () => {
    const { deps } = makeDeps([makeRawIssueNoEstimate()]);
    const before = await getIssuePanel(deps, { issueKey: 'RS-2' });
    expect(before.score).toBe(90);

    await saveSettings(deps, {
      projectKey: 'RS',
      settings: {
        ...DEFAULT_SETTINGS,
        checksEnabled: { estimate: false, 'due-date': true },
      },
    });
    const after = await getIssuePanel(deps, { issueKey: 'RS-2' });
    expect(after.fromCache).toBe(false);
    expect(after.score).toBe(100);
  });

  it('A8: rescores when the effective field map changes under an unchanged issue', async () => {
    const { deps, store } = makeDeps([
      makeRawIssue({ customfield_10016: null, customfield_10042: 5 }),
    ]);
    const before = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(before.score).toBe(90); // story points sit under 10042; default map reads 10016

    await store.setFieldMap({
      storyPoints: 'customfield_10042',
      epicLink: 'customfield_10014',
      acceptanceCriteria: null,
    });
    const after = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(after.fromCache).toBe(false);
    expect(after.score).toBe(100);
  });

  it('B8: resolves story points from the site field list, cached after one lookup', async () => {
    const fields: JiraFieldInfo[] = [
      { id: 'customfield_10042', name: 'Story point estimate', custom: true },
      { id: 'customfield_10014', name: 'Epic Link', custom: true },
    ];
    const jira = new FakeJiraAdapter(
      [makeRawIssue({ customfield_10016: null, customfield_10042: 5 }, 'RS-5')],
      fields,
    );
    const { deps } = makeDepsWithJira(jira);
    const panel = await getIssuePanel(deps, { issueKey: 'RS-5' });
    expect(panel.score).toBe(100);
    expect(jira.listFieldsCalls).toHaveLength(1);

    await getIssuePanel(deps, { issueKey: 'RS-5' });
    expect(jira.listFieldsCalls).toHaveLength(1); // served from the KVS cache

    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.fieldMap.storyPoints).toBe('customfield_10042');
  });

  it('scores the messy fixture at 20, grade not-ready', async () => {
    const { deps } = makeDeps([makeRawMessyIssue()]);
    const panel = await getIssuePanel(deps, { issueKey: 'RS-3' });
    expect(panel.score).toBe(20);
    expect(panel.grade).toBe('not-ready');
  });
});

describe('getProjectDashboard', () => {
  it('scans on first open and returns hand-computed stats', async () => {
    const { deps } = makeDeps([makeRawIssue(), makeRawIssueNoEstimate(), makeRawMessyIssue()]);
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.stats.openScored).toBe(3);
    expect(dashboard.stats.averageScore).toBe(70);
    expect(dashboard.stats.percentReady).toBe(66.7);
    expect(dashboard.stats.counts).toEqual({ ready: 2, almost: 0, 'not-ready': 1 });
    expect(dashboard.stats.worstOffenders.map((record) => record.issueKey)).toEqual([
      'RS-3',
      'RS-2',
      'RS-1',
    ]);
    expect(dashboard.scanStatus).toBe('complete');
    expect(dashboard.canEditSettings).toBe(true);
  });

  it('B1/B4: scans one page per open and reports progress until continued', async () => {
    const issues = Array.from({ length: 150 }, (_, index) =>
      makeRawIssue({}, `RS-${index + 1}`),
    );
    const { deps, jira } = makeDeps(issues);
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.stats.openScored).toBe(100);
    expect(dashboard.scanStatus).toBe('scanning');
    expect(jira.searchCalls.map((call) => call.pageToken)).toEqual([null]);

    const continued = await continueScanProject(deps, { projectKey: 'RS' });
    expect(continued).toEqual({ projectKey: 'RS', scanned: 50, resumed: true, complete: true });
    expect(jira.searchCalls.map((call) => call.pageToken)).toEqual([null, 'pg:100']);

    const after = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(after.stats.openScored).toBe(150);
    expect(after.stats.worstOffenders).toHaveLength(25);
    expect(after.scanStatus).toBe('complete');
  });

  it('A1: an event-scored issue does not suppress the first dashboard scan', async () => {
    const issues = [makeRawIssue(), makeRawIssueNoEstimate(), makeRawMessyIssue()];
    const { deps, jira } = makeDeps(issues);
    await handleIssueEvent(deps, v2Event(issues[0] as RawJiraIssue));
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(jira.searchCalls.length).toBeGreaterThan(0);
    expect(dashboard.stats.openScored).toBe(3);
  });

  it('re-buckets counts when thresholds change, without a rescan', async () => {
    const { deps } = makeDeps([makeRawIssue(), makeRawIssueNoEstimate()]);
    await getProjectDashboard(deps, { projectKey: 'RS' });
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, readyThreshold: 95 },
    });
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.stats.counts).toEqual({ ready: 1, almost: 1, 'not-ready': 0 });
  });

  it('scans an all-done project once, not on every dashboard open', async () => {
    const doneIssue = makeRawIssue(
      { status: { name: 'Done', statusCategory: { key: 'done' } } },
      'RS-50',
    );
    const { deps, jira } = makeDeps([doneIssue]);
    const first = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(first.stats.openScored).toBe(0);
    expect(first.scanStatus).toBe('complete');
    expect(jira.searchCalls).toHaveLength(1);
    const second = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(second.stats.openScored).toBe(0);
    expect(jira.searchCalls).toHaveLength(1);
  });
});

describe('rescan and scheduled rescan', () => {
  it('manual rescan starts fresh, runs one chunk; continuation resumes it', async () => {
    const issues = Array.from({ length: 150 }, (_, index) =>
      makeRawIssue({}, `RS-${index + 1}`),
    );
    const { deps, store } = makeDeps(issues);
    await store.setRescanCheckpoint('RS', { nextPageToken: 'pg:100', seenKeys: ['RS-1'] });
    const first = await rescanProject(deps, { projectKey: 'RS' });
    expect(first).toEqual({ projectKey: 'RS', scanned: 100, resumed: false, complete: false });
    const continued = await continueScanProject(deps, { projectKey: 'RS' });
    expect(continued).toEqual({ projectKey: 'RS', scanned: 50, resumed: true, complete: true });
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
  });

  it('scheduled rescan covers every known project and resumes checkpoints', async () => {
    const opsIssue = makeRawIssue({ project: { key: 'OPS' } }, 'OPS-1');
    const { deps, store } = makeDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
      opsIssue,
    ]);
    // Register both projects (a dashboard open is what registers them).
    await getProjectDashboard(deps, { projectKey: 'RS' });
    await getProjectDashboard(deps, { projectKey: 'OPS' });
    await store.setRescanCheckpoint('RS', {
      nextPageToken: 'pg:2',
      seenKeys: ['RS-1', 'RS-2'],
    });

    const result = await handleScheduledRescan(deps);
    expect(result.errors).toEqual([]);
    const rs = result.projects.find((candidate) => candidate.projectKey === 'RS');
    const ops = result.projects.find((candidate) => candidate.projectKey === 'OPS');
    expect(rs).toEqual({ projectKey: 'RS', scanned: 1, complete: true });
    expect(ops).toEqual({ projectKey: 'OPS', scanned: 1, complete: true });
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
  });

  it('A9: a scan that fails after page 1 checkpoints; the next run resumes and finishes', async () => {
    class FailSecondPageOnce extends FakeJiraAdapter {
      private failed = false;
      override async searchIssues(
        jql: string,
        pageToken: string | null,
        maxResults: number,
      ): Promise<SearchPage> {
        if (pageToken !== null && !this.failed) {
          this.failed = true;
          throw new Error('HTTP 503 from Jira');
        }
        return super.searchIssues(jql, pageToken, maxResults);
      }
    }
    const issues = Array.from({ length: 150 }, (_, index) =>
      makeRawIssue({}, `RS-${index + 1}`),
    );
    const { deps, store } = makeDepsWithJira(new FailSecondPageOnce(issues));
    await store.registerProject('RS');

    const first = await handleScheduledRescan(deps);
    expect(first.projects).toEqual([]);
    expect(first.errors).toEqual([{ projectKey: 'RS', error: 'HTTP 503 from Jira' }]);
    const checkpoint = await store.getRescanCheckpoint('RS');
    expect(checkpoint?.nextPageToken).toBe('pg:100');
    expect(checkpoint?.seenKeys).toHaveLength(100);
    expect((await store.getScanState('RS'))?.status).toBe('failed');

    const second = await handleScheduledRescan(deps);
    expect(second.errors).toEqual([]);
    expect(second.projects).toEqual([{ projectKey: 'RS', scanned: 50, complete: true }]);
    expect(await store.getProjectScores('RS')).toHaveLength(150);
    expect(await store.getRescanCheckpoint('RS')).toBeUndefined();
    expect((await store.getScanState('RS'))?.status).toBe('complete');
  });

  it('A9: an invalid stored page token restarts the scan cleanly', async () => {
    const { deps, store } = makeDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    await store.setRescanCheckpoint('RS', { nextPageToken: 'not-a-real-token', seenKeys: [] });
    const result = await scanProject(deps, 'RS', { resume: true });
    expect(result).toEqual({ projectKey: 'RS', scanned: 3, resumed: false, complete: true });
    expect(await store.getProjectScores('RS')).toHaveLength(3);
  });

  it('A2: a reconciling scan removes the record of an issue closed without an event', async () => {
    const raws = [makeRawIssue(), makeRawIssueNoEstimate()];
    const { deps, store } = makeDeps(raws);
    await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(await store.getProjectScores('RS')).toHaveLength(2);

    const closed = raws[1]?.fields;
    if (!closed) throw new Error('fixture missing');
    closed.status = { name: 'Done', statusCategory: { key: 'done' } };
    closed.updated = '2026-11-18T09:00:00.000Z';

    const result = await handleScheduledRescan(deps);
    expect(result.errors).toEqual([]);
    expect(await store.getScore('RS-2')).toBeUndefined();
    expect((await store.getProjectScores('RS')).map((record) => record.issueKey)).toEqual([
      'RS-1',
    ]);
  });

  it('A4/B11: one failing project is reported and does not abort the others', async () => {
    class BadProjectJira extends FakeJiraAdapter {
      override async searchIssues(
        jql: string,
        pageToken: string | null,
        maxResults: number,
      ): Promise<SearchPage> {
        if (jql.includes('"BAD"')) throw new Error('HTTP 500 from Jira');
        return super.searchIssues(jql, pageToken, maxResults);
      }
    }
    const { deps, store } = makeDepsWithJira(new BadProjectJira([makeRawIssue()]));
    await store.registerProject('BAD');
    await store.registerProject('RS');

    const result = await handleScheduledRescan(deps);
    expect(result.errors).toEqual([{ projectKey: 'BAD', error: 'HTTP 500 from Jira' }]);
    expect(result.projects).toEqual([{ projectKey: 'RS', scanned: 1, complete: true }]);
  });
});

describe('handleIssueEvent', () => {
  it('B5: scores a v2 payload by merging customFields, without any REST call', async () => {
    const { deps, store, jira } = makeDeps([makeRawIssue({}, 'RS-7')]);
    const result = await handleIssueEvent(deps, v2Event(makeRawIssue({}, 'RS-7')));
    expect(result).toEqual({ handled: true, issueKey: 'RS-7' });
    const record = await store.getScore('RS-7');
    expect(record?.score).toBe(100);
    expect(record?.source).toBe('event');
    expect(jira.getIssueCalls).toEqual([]);
  });

  it('B5/A7: story points carried only in customFields are not lost', async () => {
    const raw = makeRawIssue({ customfield_10016: null }, 'RS-8');
    const event = v2Event(raw);
    event.customFields = { customfield_10016: 5 };
    const { deps, store } = makeDeps([raw]);
    const result = await handleIssueEvent(deps, event);
    expect(result.handled).toBe(true);
    expect((await store.getScore('RS-8'))?.score).toBe(100);
  });

  it('B5: falls back to REST when the event omits custom fields', async () => {
    const { deps, store, jira } = makeDeps([makeRawIssue({}, 'RS-7')]);
    const event = v2Event(makeRawIssue({}, 'RS-7'));
    event.customFieldsStatus = 'OMITTED';
    delete event.customFields;
    const result = await handleIssueEvent(deps, event);
    expect(result).toEqual({ handled: true, issueKey: 'RS-7' });
    expect(jira.getIssueCalls).toEqual(['RS-7']);
    const record = await store.getScore('RS-7');
    expect(record?.score).toBe(100);
    expect(record?.source).toBe('rest');
  });

  it('A11: an event whose issue carries no fields is not handled and stores nothing', async () => {
    const { deps, store } = makeDeps([]);
    const result = await handleIssueEvent(deps, {
      eventType: 'avi:jira:updated:issue',
      issue: { key: 'RS-9' } as RawJiraIssue,
    });
    expect(result).toEqual({ handled: false });
    expect(await store.getScore('RS-9')).toBeUndefined();
  });

  it('B9: a deleted-issue event removes the stored score immediately', async () => {
    const { deps, store } = makeDeps([makeRawIssue({}, 'RS-7')]);
    await handleIssueEvent(deps, v2Event(makeRawIssue({}, 'RS-7')));
    expect(await store.getScore('RS-7')).toBeDefined();
    const result = await handleIssueEvent(
      deps,
      v2Event(makeRawIssue({}, 'RS-7'), 'avi:jira:deleted:issue'),
    );
    expect(result).toEqual({ handled: true, issueKey: 'RS-7' });
    expect(await store.getScore('RS-7')).toBeUndefined();
  });

  it('ignores event types it does not subscribe to', async () => {
    const { deps } = makeDeps([]);
    const result = await handleIssueEvent(
      deps,
      v2Event(makeRawIssue(), 'avi:jira:comment:created'),
    );
    expect(result).toEqual({ handled: false });
  });
});

describe('settings handlers', () => {
  it('returns defaults, then clamps and enforces threshold ordering on save', async () => {
    const { deps } = makeDeps([]);
    expect(await getSettings(deps, { projectKey: 'RS' })).toEqual(DEFAULT_SETTINGS);

    const clamped = await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, readyThreshold: 140, almostThreshold: 130 },
    });
    expect(clamped.readyThreshold).toBe(100);
    expect(clamped.almostThreshold).toBe(100);

    const ordered = await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, readyThreshold: 70, almostThreshold: 90 },
    });
    expect(ordered.readyThreshold).toBe(70);
    expect(ordered.almostThreshold).toBe(70);
  });

  it('A21: a NaN threshold falls back to the current value instead of being stored', async () => {
    const { deps } = makeDeps([]);
    const saved = await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, readyThreshold: Number.NaN },
    });
    expect(saved.readyThreshold).toBe(DEFAULT_SETTINGS.readyThreshold);
    expect(Number.isFinite(saved.readyThreshold)).toBe(true);
  });

  it('A21: a partial checksEnabled object merges over the current settings', async () => {
    const { deps } = makeDeps([]);
    const partial = {
      readyThreshold: 85,
      almostThreshold: 65,
      checksEnabled: { estimate: false },
    } as unknown as ProjectSettings;
    const saved = await saveSettings(deps, { projectKey: 'RS', settings: partial });
    expect(saved.readyThreshold).toBe(85);
    expect(saved.checksEnabled).toEqual({ estimate: false, 'due-date': true });
  });

  it('B13: saveSettings rejects users without project-admin permission', async () => {
    const jira = new FakeJiraAdapter([makeRawIssue()]);
    jira.adminProjects = new Set<string>(); // administers nothing
    const { deps } = makeDepsWithJira(jira);
    await expect(
      saveSettings(deps, { projectKey: 'RS', settings: DEFAULT_SETTINGS }),
    ).rejects.toThrow(/Only project administrators/);
    const dashboard = await getProjectDashboard(deps, { projectKey: 'RS' });
    expect(dashboard.canEditSettings).toBe(false);
  });
});
