/**
 * Production Jira adapter backed by `@forge/api`'s requestJira.
 * This is the ONLY module that performs Jira REST calls; everything
 * else consumes the {@link JiraAdapter} interface (see `jira.ts`).
 *
 * Runs as the app (asApp) — ReadySet scores work, it does not act as
 * the viewing user. Scopes: read:jira-work, write:jira-work.
 */
import api, { route } from '@forge/api';
import type { JiraAdapter, RawJiraIssue, SearchPage } from './jira';
import { DEFAULT_FIELD_MAP } from './jira';

const SEARCH_FIELDS = [
  'summary',
  'description',
  'priority',
  'assignee',
  'labels',
  'components',
  'issuelinks',
  'parent',
  'duedate',
  'timeestimate',
  'status',
  'project',
  'updated',
  DEFAULT_FIELD_MAP.storyPoints,
  DEFAULT_FIELD_MAP.epicLink,
];

async function readJson<T>(response: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }, what: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ReadySet: ${what} failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

export class ForgeJiraAdapter implements JiraAdapter {
  async getIssue(issueKey: string): Promise<RawJiraIssue> {
    const response = await api
      .asApp()
      .requestJira(route`/rest/api/3/issue/${issueKey}?fields=${SEARCH_FIELDS.join(',')}`, {
        headers: { Accept: 'application/json' },
      });
    return readJson<RawJiraIssue>(response, `getIssue(${issueKey})`);
  }

  async searchIssues(jql: string, startAt: number, maxResults: number): Promise<SearchPage> {
    const response = await api.asApp().requestJira(route`/rest/api/3/search`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, startAt, maxResults, fields: SEARCH_FIELDS }),
    });
    return readJson<SearchPage>(response, 'searchIssues');
  }
}
