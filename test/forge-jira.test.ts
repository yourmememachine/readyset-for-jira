import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A-NEW-1 (cross-review round 3): the production adapter was the one
 * layer with zero test coverage — and it contained the round's worst
 * defect (B1, the removed search endpoint). These tests mock
 * `@forge/api` and pin the exact requests ForgeJiraAdapter makes.
 */
const state = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; options?: { method?: string; body?: string } }>,
  responder: (_url: string): { ok: boolean; status: number; body: unknown } => ({
    ok: true,
    status: 200,
    body: { issues: [], isLast: true },
  }),
}));

vi.mock('@forge/api', () => {
  const makeRequester = () => ({
    requestJira: async (url: unknown, options?: { method?: string; body?: string }) => {
      const urlString = String(url);
      state.requests.push({ url: urlString, options });
      const response = state.responder(urlString);
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
        text: async () => JSON.stringify(response.body),
      };
    },
  });
  return {
    default: { asApp: () => makeRequester(), asUser: () => makeRequester() },
    route: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce(
        (acc, part, index) => acc + part + (values[index] !== undefined ? String(values[index]) : ''),
        '',
      ),
  };
});

import { ForgeJiraAdapter } from '../src/lib/forge-jira';
import { InvalidPageTokenError } from '../src/lib/jira';

beforeEach(() => {
  state.requests.length = 0;
  state.responder = () => ({ ok: true, status: 200, body: { issues: [], isLast: true } });
});

describe('ForgeJiraAdapter (mocked @forge/api)', () => {
  it('B1: searches via POST /rest/api/3/search/jql with a token body, never the removed endpoint', async () => {
    const adapter = new ForgeJiraAdapter('app');
    await adapter.searchIssues('project = "RS"', null, 100);
    expect(state.requests).toHaveLength(1);
    const first = state.requests[0];
    expect(first?.url).toBe('/rest/api/3/search/jql');
    expect(first?.options?.method).toBe('POST');
    const body = JSON.parse(first?.options?.body ?? '{}') as Record<string, unknown>;
    expect(body.jql).toBe('project = "RS"');
    expect(body.maxResults).toBe(100);
    expect(body.nextPageToken).toBeUndefined();
    expect(body.fields).toContain('timeoriginalestimate');
    expect(body.fields).toContain('customfield_10016');

    await adapter.searchIssues('project = "RS"', 'tok-abc', 100);
    const secondBody = JSON.parse(state.requests[1]?.options?.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(secondBody.nextPageToken).toBe('tok-abc');
  });

  it('B1/A-NEW-2: an HTTP 400 on a token search becomes InvalidPageTokenError; a 500 does not', async () => {
    state.responder = () => ({ ok: false, status: 400, body: { errorMessages: ['bad token'] } });
    const adapter = new ForgeJiraAdapter('app');
    await expect(adapter.searchIssues('project = "RS"', 'stale-token', 100)).rejects.toBeInstanceOf(
      InvalidPageTokenError,
    );

    state.responder = () => ({ ok: false, status: 500, body: {} });
    await expect(adapter.searchIssues('project = "RS"', 'tok', 100)).rejects.toThrow(/HTTP 500/);
  });

  it('B18/A6: getIssue requests the issue with both estimate fields in the query', async () => {
    state.responder = () => ({ ok: true, status: 200, body: { key: 'RS-1', fields: {} } });
    const adapter = new ForgeJiraAdapter('user');
    await adapter.getIssue('RS-1');
    const url = state.requests[0]?.url ?? '';
    expect(url.startsWith('/rest/api/3/issue/RS-1?')).toBe(true);
    const query = decodeURIComponent(url.slice(url.indexOf('?') + 1));
    expect(query).toContain('fields=');
    expect(query).toContain('timeoriginalestimate');
    expect(query).toContain('timeestimate');
    expect(query).toContain('customfield_10016');
  });

  it('B8: listFields maps the /rest/api/3/field response', async () => {
    state.responder = () => ({
      ok: true,
      status: 200,
      body: [
        { id: 'customfield_10042', name: 'Story point estimate', custom: true },
        { id: 'summary', name: 'Summary' },
      ],
    });
    const adapter = new ForgeJiraAdapter('app');
    const fields = await adapter.listFields();
    expect(state.requests[0]?.url).toBe('/rest/api/3/field');
    expect(fields).toEqual([
      { id: 'customfield_10042', name: 'Story point estimate', custom: true },
      { id: 'summary', name: 'Summary', custom: false },
    ]);
  });

  it('B13: hasProjectPermission reads havePermission from mypermissions', async () => {
    state.responder = () => ({
      ok: true,
      status: 200,
      body: { permissions: { ADMINISTER_PROJECTS: { havePermission: true } } },
    });
    const adapter = new ForgeJiraAdapter('user');
    await expect(adapter.hasProjectPermission('RS', 'ADMINISTER_PROJECTS')).resolves.toBe(true);
    expect(state.requests[0]?.url).toContain('/rest/api/3/mypermissions?');
    expect(state.requests[0]?.url).toContain('projectKey=RS');

    state.responder = () => ({
      ok: true,
      status: 200,
      body: { permissions: { ADMINISTER_PROJECTS: { havePermission: false } } },
    });
    await expect(adapter.hasProjectPermission('RS', 'ADMINISTER_PROJECTS')).resolves.toBe(false);
  });

  it('B14: an error response body never leaks into the thrown message', async () => {
    state.responder = () => ({
      ok: false,
      status: 403,
      body: { errorMessages: ['SECRET-DETAIL-xyz'] },
    });
    const adapter = new ForgeJiraAdapter('app');
    await expect(adapter.getIssue('RS-1')).rejects.toThrow(/HTTP 403/);
    await expect(adapter.getIssue('RS-1')).rejects.not.toThrow(/SECRET-DETAIL/);
  });
});
