/**
 * Product-event trigger handler (manifest: `trigger` on
 * avi:jira:created:issue / avi:jira:updated:issue).
 *
 * Forge delivers the full issue in the event payload, so rescoring an
 * issue on change costs no extra REST call: normalize, score, cache.
 */
import { normalizeIssue, type RawJiraIssue } from '../lib/jira';
import { scoreIssue } from '../lib/rubric';
import type { ResolverDeps } from './resolver';
import { settingsFingerprint } from './resolver';
import type { StoredScore } from '../lib/types';

export interface IssueEventPayload {
  eventType?: string;
  issue?: RawJiraIssue;
}

export interface IssueEventResult {
  handled: boolean;
  issueKey?: string;
  score?: number;
}

export async function handleIssueEvent(
  deps: ResolverDeps,
  event: IssueEventPayload,
): Promise<IssueEventResult> {
  const raw = event.issue;
  if (!raw || typeof raw.key !== 'string') {
    return { handled: false };
  }
  const issue = normalizeIssue(raw, deps.fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const scored = scoreIssue(issue, settings);
  const record: StoredScore = {
    ...scored,
    projectKey: issue.projectKey,
    summary: issue.summary,
    statusName: issue.statusName,
    statusCategory: issue.statusCategory,
    issueUpdated: issue.updated,
    computedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    settingsFingerprint: settingsFingerprint(settings),
  };
  await deps.store.saveScore(record);
  return { handled: true, issueKey: issue.key, score: scored.score };
}
