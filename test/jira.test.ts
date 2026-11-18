import { describe, expect, it } from 'vitest';
import {
  FakeJiraAdapter,
  isScoreablePayload,
  missingScoringFields,
  normalizeIssue,
  resolveFieldMap,
  type JiraFieldInfo,
  type RawJiraIssue,
} from '../src/lib/jira';
import { makeRawIssue } from './fixtures';

describe('normalizeIssue — cross-review round 3', () => {
  it('A6: reads the original estimate from timeoriginalestimate, not the remaining estimate', () => {
    const issue = normalizeIssue(
      makeRawIssue({ customfield_10016: null, timeoriginalestimate: 7200, timeestimate: 0 }),
    );
    expect(issue.originalEstimateSeconds).toBe(7200);
  });

  it('A6: falls back to the remaining estimate when no original is present', () => {
    const issue = normalizeIssue(
      makeRawIssue({ customfield_10016: null, timeoriginalestimate: null, timeestimate: 3600 }),
    );
    expect(issue.originalEstimateSeconds).toBe(3600);
  });

  it('A6: a zero original with zero remaining is still "no estimate"', () => {
    const issue = normalizeIssue(
      makeRawIssue({ customfield_10016: null, timeoriginalestimate: 0, timeestimate: 0 }),
    );
    expect(issue.originalEstimateSeconds).toBe(0);
  });
});

describe('resolveFieldMap (B8)', () => {
  const fields: JiraFieldInfo[] = [
    { id: 'customfield_10042', name: 'Story point estimate', custom: true },
    { id: 'customfield_10020', name: 'Epic Link', custom: true },
    { id: 'customfield_10077', name: 'Acceptance Criteria', custom: true },
    { id: 'summary', name: 'Summary', custom: false },
  ];

  it('resolves story points from the "Story point estimate" name (post-2020 default)', () => {
    const map = resolveFieldMap(fields);
    expect(map.storyPoints).toBe('customfield_10042');
    expect(map.epicLink).toBe('customfield_10020');
    expect(map.acceptanceCriteria).toBe('customfield_10077');
  });

  it('falls back to the compiled defaults when the site exposes no matching names', () => {
    const map = resolveFieldMap([{ id: 'summary', name: 'Summary', custom: false }]);
    expect(map.storyPoints).toBe('customfield_10016');
    expect(map.epicLink).toBe('customfield_10014');
    expect(map.acceptanceCriteria).toBeNull();
  });

  it('normalizeIssue reads story points through a resolved non-default field id', () => {
    const map = resolveFieldMap(fields);
    const issue = normalizeIssue(makeRawIssue({ customfield_10042: 5, customfield_10016: null }), map);
    expect(issue.storyPoints).toBe(5);
  });
});

describe('FakeJiraAdapter — /search/jql pagination contract (B1)', () => {
  it('paginates with opaque tokens and isLast, never offsets', async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeRawIssue({}, `RS-${i + 1}`));
    const fake = new FakeJiraAdapter(issues);
    const page1 = await fake.searchIssues('project = "RS"', null, 2);
    expect(page1.issues.map((issue) => issue.key)).toEqual(['RS-1', 'RS-2']);
    expect(page1.isLast).toBe(false);
    expect(page1.nextPageToken).toBe('pg:2');

    const page2 = await fake.searchIssues('project = "RS"', page1.nextPageToken ?? null, 2);
    expect(page2.issues.map((issue) => issue.key)).toEqual(['RS-3', 'RS-4']);
    expect(page2.isLast).toBe(false);

    const page3 = await fake.searchIssues('project = "RS"', page2.nextPageToken ?? null, 2);
    expect(page3.issues.map((issue) => issue.key)).toEqual(['RS-5']);
    expect(page3.isLast).toBe(true);
    expect(page3.nextPageToken).toBeUndefined();
  });

  it('rejects a malformed page token the way Jira rejects a bad nextPageToken', async () => {
    const fake = new FakeJiraAdapter([makeRawIssue({}, 'RS-1')]);
    await expect(fake.searchIssues('project = "RS"', 'garbage-token', 10)).rejects.toThrow(
      /Invalid or expired page token/,
    );
  });
});

describe('scoring payload completeness (live RS-2 incident)', () => {
  it('a full REST-shaped payload is complete and scoreable', () => {
    expect(missingScoringFields(makeRawIssue())).toEqual([]);
    expect(isScoreablePayload(makeRawIssue())).toBe(true);
  });

  it('present-but-null counts as present — Jira answers unset fields with null, not omission', () => {
    const raw = makeRawIssue({ description: null, assignee: null, duedate: null, parent: null });
    expect(missingScoringFields(raw)).toEqual([]);
    expect(isScoreablePayload(raw)).toBe(true);
  });

  it('a sparse field-edit payload reports every absent scoring field and is not scoreable', () => {
    // The shape delivered live for the RS-2 estimate edit: headline
    // fields plus the changed story-points value — description,
    // assignee, labels, links and both estimate fields ABSENT.
    const sparse: RawJiraIssue = {
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
    expect(missingScoringFields(sparse)).toEqual(
      expect.arrayContaining([
        'description',
        'assignee',
        'labels',
        'components',
        'issuelinks',
        'parent',
        'duedate',
        'timeestimate',
        'timeoriginalestimate',
        'customfield_10014',
      ]),
    );
    expect(isScoreablePayload(sparse)).toBe(false);
  });

  it('missingScoringFields reports the mapped custom fields under the site field map, not the defaults', () => {
    const map = {
      storyPoints: 'customfield_10042',
      epicLink: 'customfield_10014',
      acceptanceCriteria: 'customfield_10077',
    };
    // Carries the DEFAULT story-points id but not this site's mapped ids.
    const raw = makeRawIssue({ customfield_10016: 3 });
    expect(missingScoringFields(raw, map)).toEqual(
      expect.arrayContaining(['customfield_10042', 'customfield_10077']),
    );
  });

  it('an absent custom field alone does not block scoring — absence reads exactly like null', () => {
    // The B5/A7 semantics: an INCLUDED customFields map is
    // authoritative for custom state, and REST omits out-of-context
    // custom fields; neither absence is evidence of a skeleton.
    const raw = makeRawIssue({ customfield_10016: null });
    delete (raw.fields as Record<string, unknown>)['customfield_10014'];
    expect(missingScoringFields(raw)).toEqual(['customfield_10014']);
    expect(isScoreablePayload(raw)).toBe(true);
  });

  it('a payload omitting parent and the epic-link field IS scoreable — Jira omits both keys when unset', () => {
    // Live-verified 2026-11-17 via forge logs: a full REST fetch of
    // RS-2 returned every scoring field EXCEPT parent and
    // customfield_10014 — Jira does not return either key for an
    // issue with no parent and no epic, even when asked. The first
    // gate build required parent, refused every real fetch, and
    // froze the corrupt stored 35 in place (the panel kept serving
    // it; every event refetch kept it). Absence of these two keys
    // means "unset", not "skeleton".
    const raw = makeRawIssue({}, 'RS-2');
    delete (raw.fields as Record<string, unknown>)['parent'];
    delete (raw.fields as Record<string, unknown>)['customfield_10014'];
    expect(isScoreablePayload(raw)).toBe(true);
  });
});
