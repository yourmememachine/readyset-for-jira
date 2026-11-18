import { describe, expect, it } from 'vitest';
import { handleIssueEvent, resolveEventIssue, type JiraIssueEvent } from '../src/functions/events';
import { handleScheduledRescan } from '../src/functions/rescan';
import {
  continueScanProject,
  getIssuePanel,
  getProjectDashboard,
  getSettings,
  rescanProject,
  saveSettings,
  scanProject,
  scoreAndStore,
  type ResolverDeps,
} from '../src/functions/resolver';
import {
  DEFAULT_FIELD_MAP,
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

/**
 * The live RS-2 incident payload (2026-11-17, ~20:21 Vancouver):
 * editing ONE field in the Jira UI ("Story point estimate" = 3)
 * delivered an updated-issue event whose `issue.fields` carried only
 * the headline fields — description, assignee, labels, components,
 * issuelinks, parent, duedate and both estimate fields were ABSENT
 * (not null) — while `customFields` arrived INCLUDED holding just
 * the changed field. Scored directly, that skeleton earns exactly 35
 * (estimate 10 + priority 5 + no-placeholders 10 + summary 5 +
 * due-date 5) against a real issue worth 100.
 */
function sparseFieldEditEvent(issueKey: string, updated: string): JiraIssueEvent {
  return {
    eventType: 'avi:jira:updated:issue',
    issue: {
      key: issueKey,
      fields: {
        summary: 'Add rate limiting to the public API gateway endpoints',
        priority: { name: 'Medium' },
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        project: { key: 'RS' },
        updated,
      },
    },
    customFields: { customfield_10016: 3 },
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
        checksEnabled: { ...DEFAULT_SETTINGS.checksEnabled, estimate: false, 'due-date': true, 'repro-steps': true },
      },
    });
    const after = await getIssuePanel(deps, { issueKey: 'RS-2' });
    expect(after.fromCache).toBe(false);
    expect(after.score).toBe(100);
  });

  it('A1 (Wave 2 review): saving settings marks the project scan stale', async () => {
    const { deps } = makeDeps([makeRawIssueNoEstimate()]);
    await deps.store.setScanState('RS', { status: 'complete', updatedAt: '2026-11-17T00:00:00.000Z' });
    await saveSettings(deps, {
      projectKey: 'RS',
      settings: { ...DEFAULT_SETTINGS, readyThreshold: 90 },
    });
    const state = await deps.store.getScanState('RS');
    expect(state?.status).toBe('scanning');
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

  // The panel (and its Refresh button, which simply re-invokes this
  // resolver) must never score a partial payload either: an adapter
  // response missing scoring fields serves the stored record instead
  // of overwriting it with a skeleton score (live RS-2 incident —
  // the event-written 35 was also un-healable by Refresh because the
  // poisoned record's `updated` matched the real issue's).
  class SparseGetIssue extends FakeJiraAdapter {
    override async getIssue(issueKey: string): Promise<RawJiraIssue> {
      this.getIssueCalls.push(issueKey);
      return {
        key: issueKey,
        fields: {
          summary: 'Add rate limiting to the public API gateway endpoints',
          priority: { name: 'Medium' },
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          project: { key: 'RS' },
          updated: '2026-11-17T20:21:00.000Z',
        },
      };
    }
  }

  it('live RS-2 incident: a partial adapter payload is never scored — the stored score is served instead', async () => {
    const { deps, store } = makeDepsWithJira(new SparseGetIssue([]));
    const settings = await store.getSettings('RS');
    await scoreAndStore(
      deps,
      normalizeIssue(makeRawIssueNoEstimate('RS-2')),
      settings,
      DEFAULT_FIELD_MAP,
      'rest',
    );
    expect((await store.getScore('RS-2'))?.score).toBe(90);

    const panel = await getIssuePanel(deps, { issueKey: 'RS-2' });
    expect(panel.score).toBe(90);
    expect(panel.fromCache).toBe(true);
    expect((await store.getScore('RS-2'))?.score).toBe(90);
  });

  it('live RS-2 incident: a partial adapter payload with no stored score surfaces an error, not a partial score', async () => {
    const { deps, store } = makeDepsWithJira(new SparseGetIssue([]));
    await expect(getIssuePanel(deps, { issueKey: 'RS-2' })).rejects.toThrow(/incomplete/i);
    expect(await store.getScore('RS-2')).toBeUndefined();
  });

  it('live RS-2 incident, second act: a stored corrupt 35 heals from a full payload that omits parent/epic-link keys', async () => {
    // After the first fix deployed, RS-2 STILL showed 35: the gate
    // required `parent`, which Jira omits when unset, so the real
    // full payload was refused everywhere and the corrupt record
    // could never heal (forge logs: "missing: parent,
    // customfield_10014" on every fetch). This is that exact
    // payload shape — complete except the two keys Jira does not
    // return for an issue with no parent and no epic.
    const full = makeRawIssue({ updated: '2026-11-17T21:35:00.000Z' }, 'RS-2');
    delete (full.fields as Record<string, unknown>)['parent'];
    delete (full.fields as Record<string, unknown>)['customfield_10014'];
    const { deps, store } = makeDepsWithJira(new FakeJiraAdapter([full]));
    const settings = await store.getSettings('RS');
    // Plant the corrupt record the incident minted: the sparse
    // skeleton's shape scores exactly 35.
    const sparseRaw: RawJiraIssue = {
      key: 'RS-2',
      fields: {
        summary: 'Add rate limiting to the public API gateway endpoints',
        priority: { name: 'Medium' },
        status: { name: 'To Do', statusCategory: { key: 'new' } },
        project: { key: 'RS' },
        updated: '2026-11-17T20:21:00.000Z',
        customfield_10016: 3,
      },
    };
    const corrupt = await scoreAndStore(
      deps,
      normalizeIssue(sparseRaw),
      settings,
      DEFAULT_FIELD_MAP,
      'event',
    );
    expect(corrupt.score).toBe(35);

    const panel = await getIssuePanel(deps, { issueKey: 'RS-2' });
    expect(panel.score).toBe(100);
    expect(panel.fromCache).toBe(false);
    expect((await store.getScore('RS-2'))?.score).toBe(100);
    expect((await store.getScore('RS-2'))?.source).toBe('rest');
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

  it('live RS-2 incident: a sparse search payload is skipped, and reconcile keeps its previous stored score', async () => {
    class SparseSearch extends FakeJiraAdapter {
      override async searchIssues(
        jql: string,
        pageToken: string | null,
        maxResults: number,
      ): Promise<SearchPage> {
        const page = await super.searchIssues(jql, pageToken, maxResults);
        return {
          ...page,
          issues: page.issues.map((issue) =>
            issue.key === 'RS-2'
              ? {
                  key: issue.key,
                  fields: {
                    summary: issue.fields.summary,
                    priority: issue.fields.priority,
                    status: issue.fields.status,
                    project: issue.fields.project,
                    updated: issue.fields.updated,
                  },
                }
              : issue,
          ),
        };
      }
    }
    const { deps, store } = makeDepsWithJira(
      new SparseSearch([makeRawIssue(), makeRawIssueNoEstimate()]),
    );
    const settings = await store.getSettings('RS');
    await scoreAndStore(
      deps,
      normalizeIssue(makeRawIssueNoEstimate('RS-2')),
      settings,
      DEFAULT_FIELD_MAP,
      'rest',
    );
    expect((await store.getScore('RS-2'))?.score).toBe(90);

    const result = await scanProject(deps, 'RS', { resume: false });
    expect(result.complete).toBe(true);
    // Only the complete payload was scored...
    expect(result.scanned).toBe(1);
    expect((await store.getScore('RS-1'))?.score).toBe(100);
    // ...and RS-2's sparse payload neither overwrote its good record
    // nor let the reconciling scan delete it (it WAS seen).
    expect((await store.getScore('RS-2'))?.score).toBe(90);
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

  it('live RS-2 incident: a sparse field-edit event refetches and scores the FULL issue (90 -> 100), never the partial 35', async () => {
    const rs2 = makeRawIssueNoEstimate('RS-2'); // worth 90: only the estimate is missing
    const { deps, store, jira } = makeDeps([rs2]);
    await handleIssueEvent(deps, v2Event(rs2));
    expect((await store.getScore('RS-2'))?.score).toBe(90);

    // The user sets "Story point estimate" = 3 on RS-2 in the Jira UI;
    // the full issue is now worth 100.
    rs2.fields.customfield_10016 = 3;
    rs2.fields.updated = '2026-11-17T20:21:00.000Z';

    const result = await handleIssueEvent(
      deps,
      sparseFieldEditEvent('RS-2', '2026-11-17T20:21:00.000Z'),
    );
    expect(result).toEqual({ handled: true, issueKey: 'RS-2' });
    // The sparse payload must not be scored directly even though its
    // customFields arrived INCLUDED: the handler refetches over REST.
    expect(jira.getIssueCalls).toEqual(['RS-2']);
    const record = await store.getScore('RS-2');
    expect(record?.score).toBe(100);
    expect(record?.source).toBe('rest');
  });

  it('live RS-2 incident: when the refetch after a sparse event fails, the previous stored score is kept', async () => {
    class FailingGetIssue extends FakeJiraAdapter {
      override async getIssue(): Promise<RawJiraIssue> {
        throw new Error('HTTP 500 from Jira');
      }
    }
    const { deps, store } = makeDepsWithJira(new FailingGetIssue([]));
    const settings = await store.getSettings('RS');
    await scoreAndStore(
      deps,
      normalizeIssue(makeRawIssueNoEstimate('RS-2')),
      settings,
      DEFAULT_FIELD_MAP,
      'rest',
    );
    expect((await store.getScore('RS-2'))?.score).toBe(90);

    const result = await handleIssueEvent(
      deps,
      sparseFieldEditEvent('RS-2', '2026-11-17T20:21:00.000Z'),
    );
    expect(result).toEqual({ handled: false });
    // No partial record was written over the good one.
    expect((await store.getScore('RS-2'))?.score).toBe(90);
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
    // Wave 2: the merge now produces the full map — the partial key
    // overrides, every other check keeps its current (default) value.
    expect(saved.checksEnabled).toEqual({ ...DEFAULT_SETTINGS.checksEnabled, estimate: false });
    expect(saved.weights).toEqual(DEFAULT_SETTINGS.weights);
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

describe('entity property + panel history (upgrade pack)', () => {
  it('scoring writes the readyset entity property with score and grade', async () => {
    const { deps, jira } = makeDeps([makeRawIssue()]);
    const panel = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(panel.score).toBe(100);
    expect(jira.setScorePropertyCalls).toEqual([
      { issueKey: 'RS-1', value: { score: 100, grade: 'ready', updatedAt: FIXED_NOW.toISOString() } },
    ]);
  });

  it('a failing property write never fails scoring (best-effort contract)', async () => {
    const jira = new FakeJiraAdapter([makeRawIssue()]);
    jira.setScorePropertyError = new Error('property store unavailable');
    const { deps } = makeDepsWithJira(jira);
    const panel = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(panel.score).toBe(100);
    expect(jira.setScorePropertyCalls).toHaveLength(1);
  });

  it('panel payload carries the history transition after a score change', async () => {
    const raw = makeRawMessyIssue('RS-3');
    const { deps, jira } = makeDeps([raw]);
    const before = await getIssuePanel(deps, { issueKey: 'RS-3' });
    expect(before.score).toBe(20);
    expect(before.history.map((entry) => entry.score)).toEqual([20]);
    // Fix the issue in place (full description + estimate + assignee +
    // label + link, mirroring an Improve apply), then rescore.
    Object.assign(raw.fields, makeRawIssue({}, 'RS-3').fields);
    raw.fields.updated = '2026-11-17T12:30:00.000Z';
    const after = await getIssuePanel(deps, { issueKey: 'RS-3' });
    expect(after.score).toBe(100);
    expect(after.history.map((entry) => entry.score)).toEqual([20, 100]);
  });
});

describe('upgrade cross-review fixes (A1 event type gate, B2 property skip)', () => {
  it('A1: a complete event payload without issuetype classifies as refetch, never merged', () => {
    const event = v2Event(makeRawIssue({ issuetype: { name: 'Bug' } }, 'RS-11'));
    delete event.issue.fields.issuetype;
    expect(resolveEventIssue(event).kind).toBe('refetch');
  });

  it('A1: a typeless bug event refetches and scores WITH the bug pack (91, not 100)', async () => {
    const restRaw = makeRawIssue({ issuetype: { name: 'Bug' } }, 'RS-11');
    const { deps, store, jira } = makeDeps([restRaw]);
    const event = v2Event(restRaw);
    delete event.issue.fields.issuetype;
    const result = await handleIssueEvent(deps, event);
    expect(result).toEqual({ handled: true, issueKey: 'RS-11' });
    expect(jira.getIssueCalls).toEqual(['RS-11']);
    const record = await store.getScore('RS-11');
    expect(record?.source).toBe('rest');
    expect(record?.score).toBe(91);
    expect(record?.checks.find((check) => check.id === 'repro-steps')?.passed).toBe(false);
  });

  it('A1: a refetch that still lacks issuetype keeps the stored score (nothing written)', async () => {
    const restRaw = makeRawIssue({}, 'RS-12');
    delete restRaw.fields.issuetype;
    const { deps, store, jira } = makeDeps([restRaw]);
    const event = v2Event(restRaw);
    const result = await handleIssueEvent(deps, event);
    expect(result.handled).toBe(false);
    expect(jira.getIssueCalls).toEqual(['RS-12']);
    expect(await store.getScore('RS-12')).toBeUndefined();
  });

  it('B2: an unchanged rescore does not rewrite the entity property; a changed one does', async () => {
    const raw = makeRawIssue();
    const { deps, jira } = makeDeps([raw]);
    await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(jira.setScorePropertyCalls).toHaveLength(1);
    // Same content, new `updated` stamp: forces a rescore, same score.
    raw.fields.updated = '2026-11-17T13:00:00.000Z';
    const rescored = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(rescored.fromCache).toBe(false);
    expect(rescored.score).toBe(100);
    expect(jira.setScorePropertyCalls).toHaveLength(1);
    // Content change that moves the score: the property is rewritten.
    raw.fields.description = null;
    raw.fields.updated = '2026-11-17T14:00:00.000Z';
    const changed = await getIssuePanel(deps, { issueKey: 'RS-1' });
    expect(changed.score).toBeLessThan(100);
    expect(jira.setScorePropertyCalls).toHaveLength(2);
  });
});
