/**
 * Production Jira adapter backed by `@forge/api`'s requestJira.
 * This is the ONLY module that performs Jira REST calls; everything
 * else consumes the {@link JiraAdapter} interface (see `jira.ts`).
 *
 * Two modes (cross-review B12):
 * - `app` (asApp): triggers and scheduled work, where no user context
 *   exists.
 * - `user` (asUser): UI-invoked reads, so the dashboard and panel can
 *   never surface issues the viewing user is not allowed to see in
 *   Jira itself (issue-level security).
 *
 * Scopes: read:jira-work, storage:app. (write:jira-work was dropped in
 * cross-review B17 — nothing writes to Jira until the phase-2 Improve
 * Apply flow, which will re-add it with the build that uses it.)
 */
import api, { route } from '@forge/api';
import type { JiraAdapter, JiraFieldInfo, JiraFieldMap, RawJiraIssue, SearchPage } from './jira';
import { DEFAULT_FIELD_MAP, InvalidPageTokenError } from './jira';

const BASE_FIELDS = [
  'summary',
  'description',
  'priority',
  'assignee',
  'labels',
  'components',
  'issuelinks',
  'parent',
  'duedate',
  // Both estimate fields: `timeoriginalestimate` is the original
  // estimate, `timeestimate` the remaining one (cross-review A6).
  'timeoriginalestimate',
  'timeestimate',
  'status',
  'project',
  'updated',
];

function fieldsFor(fieldMap: JiraFieldMap): string[] {
  const fields = [...BASE_FIELDS, fieldMap.storyPoints, fieldMap.epicLink];
  if (fieldMap.acceptanceCriteria) fields.push(fieldMap.acceptanceCriteria);
  return [...new Set(fields)];
}

interface RestResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

async function readJson<T>(response: RestResponse, what: string): Promise<T> {
  if (!response.ok) {
    // The response body goes to the invocation log only. Raw REST
    // bodies must never reach the UI (cross-review B14) — the thrown
    // message stays short and status-coded so the frontend can map it
    // to a user-facing sentence.
    const body = await response.text().catch(() => '');
    console.error(`ReadySet: ${what} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
    throw new Error(`ReadySet: ${what} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export class ForgeJiraAdapter implements JiraAdapter {
  constructor(private readonly mode: 'app' | 'user' = 'app') {}

  private requester() {
    return this.mode === 'user' ? api.asUser() : api.asApp();
  }

  async getIssue(issueKey: string, fieldMap: JiraFieldMap = DEFAULT_FIELD_MAP): Promise<RawJiraIssue> {
    // Query composed with URLSearchParams per the documented `route`
    // pattern — interpolating the comma-joined list as one value would
    // percent-encode the commas (cross-review B18).
    const query = new URLSearchParams({ fields: fieldsFor(fieldMap).join(',') });
    const response = await this.requester().requestJira(
      route`/rest/api/3/issue/${issueKey}?${query}`,
      { headers: { Accept: 'application/json' } },
    );
    return readJson<RawJiraIssue>(response, `getIssue(${issueKey})`);
  }

  async searchIssues(
    jql: string,
    pageToken: string | null,
    maxResults: number,
    fieldMap: JiraFieldMap = DEFAULT_FIELD_MAP,
  ): Promise<SearchPage> {
    // POST /rest/api/3/search/jql — the legacy /search endpoint was
    // removed from Jira Cloud (410 Gone, CHANGE-2046). Pagination is
    // by opaque nextPageToken; there is no total/offset (B1).
    const body: Record<string, unknown> = {
      jql,
      maxResults,
      fields: fieldsFor(fieldMap),
    };
    if (pageToken !== null) body.nextPageToken = pageToken;
    const response = await this.requester().requestJira(route`/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    try {
      return await readJson<SearchPage>(response, 'searchIssues');
    } catch (err) {
      // Jira answers a bad/expired nextPageToken with HTTP 400; surface
      // it as the dedicated type so scan code can restart safely
      // (cross-review A-NEW-2). Every other failure propagates as-is.
      if (pageToken !== null && err instanceof Error && /HTTP 400/.test(err.message)) {
        throw new InvalidPageTokenError(pageToken);
      }
      throw err;
    }
  }

  async listFields(): Promise<JiraFieldInfo[]> {
    const response = await this.requester().requestJira(route`/rest/api/3/field`, {
      headers: { Accept: 'application/json' },
    });
    const fields = await readJson<Array<{ id: string; name: string; custom?: boolean }>>(
      response,
      'listFields',
    );
    return fields.map((field) => ({
      id: field.id,
      name: field.name,
      custom: field.custom ?? false,
    }));
  }

  async hasProjectPermission(projectKey: string, permission: string): Promise<boolean> {
    // Always checked as the current user, regardless of adapter mode:
    // the question is what *this* user may do (cross-review B13).
    const query = new URLSearchParams({ projectKey, permissions: permission });
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/mypermissions?${query}`, {
        headers: { Accept: 'application/json' },
      });
    const result = await readJson<{
      permissions?: Record<string, { havePermission?: boolean }>;
    }>(response, 'hasProjectPermission');
    return result.permissions?.[permission]?.havePermission === true;
  }
}
