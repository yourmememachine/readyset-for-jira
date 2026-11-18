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
 * Scopes: read:jira-work, write:jira-work, storage:app. The write
 * scope returned in phase 2a with the Improve Apply flow — the only
 * Jira writes in the app (description replace + improvement comment),
 * both below.
 */
import api, { route } from '@forge/api';
import type { AdfDoc } from './adf';
import type { JiraAdapter, JiraFieldInfo, JiraFieldMap, RawJiraIssue, SearchPage } from './jira';
import { DEFAULT_FIELD_MAP, InvalidPageTokenError, SCORING_FIELD_KEYS } from './jira';

// The fields every read requests: exactly the set scoring consumes,
// so a payload Jira answers is complete by the contract in jira.ts
// (a field Jira is asked for comes back present, null when unset).
const BASE_FIELDS: readonly string[] = SCORING_FIELD_KEYS;

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

/** Assert a write succeeded; write endpoints return little or no body. */
async function assertOk(response: RestResponse, what: string): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => '');
  console.error(`ReadySet: ${what} failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  throw new Error(`ReadySet: ${what} failed with HTTP ${response.status}`);
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

  async updateDescription(issueKey: string, description: AdfDoc): Promise<void> {
    // PUT /rest/api/3/issue/{key} with a fields payload; 204 on success.
    // notifyUsers=false: an automated rewrite must not spam watchers —
    // the improvement comment is the visible audit trail.
    const query = new URLSearchParams({ notifyUsers: 'false' });
    const response = await this.requester().requestJira(
      route`/rest/api/3/issue/${issueKey}?${query}`,
      {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { description } }),
      },
    );
    await assertOk(response, `updateDescription(${issueKey})`);
  }

  async addComment(issueKey: string, body: AdfDoc): Promise<void> {
    // POST /rest/api/3/issue/{key}/comment with an ADF body; 201 on success.
    const response = await this.requester().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    await assertOk(response, `addComment(${issueKey})`);
  }
}
