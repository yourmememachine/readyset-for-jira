import { describe, expect, it } from 'vitest';
import {
  FakeJiraAdapter,
  normalizeIssue,
  resolveFieldMap,
  type JiraFieldInfo,
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
