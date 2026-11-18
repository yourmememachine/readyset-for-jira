/**
 * Issue-event trigger handler (`avi:jira:created:issue`,
 * `avi:jira:updated:issue`, `avi:jira:deleted:issue`).
 *
 * Rescores the changed issue immediately so the panel and dashboard
 * never wait for the nightly rescan. Triggers run asApp — there is no
 * user context in an event invocation.
 *
 * Webhook payloads carry custom fields in a separate top-level
 * `customFields` map, not under `issue.fields` (verified against a
 * real payload capture in cross-review B5 — the manifest comment in
 * DESIGN.md §5.1 claiming "same shape as GET /issue" was wrong, and
 * round-1 tests used REST-shaped fixtures, so this merge was never
 * exercised). The payload also carries `customFieldsStatus`:
 * 'INCLUDED' means the map is authoritative for this event; 'OMITTED'
 * (or a missing map on a legacy payload) means the event does not
 * carry custom fields at all and the issue must be re-fetched over
 * REST — otherwise story points and epic links silently vanish from
 * event-scored records (finding A7/B5).
 */
import { normalizeIssue, type RawJiraIssue } from '../lib/jira';
import { getEffectiveFieldMap, scoreAndStore, settingsFingerprint, type ResolverDeps } from './resolver';

export interface JiraIssueEvent {
  eventType: string;
  issue: RawJiraIssue;
  /** Custom-field values, keyed by field id — NOT part of `issue.fields`. */
  customFields?: Record<string, unknown>;
  /** 'INCLUDED' when customFields is authoritative; 'OMITTED' otherwise. */
  customFieldsStatus?: 'INCLUDED' | 'OMITTED';
  changelog?: unknown;
}

export interface EventResult {
  handled: boolean;
  issueKey?: string;
}

const CREATED_OR_UPDATED = new Set(['avi:jira:created:issue', 'avi:jira:updated:issue']);
const DELETED = 'avi:jira:deleted:issue';

export type EventIssueResolution =
  | { kind: 'merged'; raw: RawJiraIssue }
  | { kind: 'refetch' }
  | { kind: 'invalid' };

/**
 * Classify an event payload:
 * - `merged` — custom fields were INCLUDED; the REST-shaped issue is
 *   the payload with `customFields` merged into `fields`.
 * - `refetch` — the payload is well-formed but omits custom fields;
 *   the issue must be re-fetched over REST.
 * - `invalid` — the payload is missing the parts normalizeIssue trusts
 *   (`fields`, a string `fields.updated`); a malformed payload must
 *   not mint a corrupt cache record (cross-review A11).
 */
export function resolveEventIssue(event: JiraIssueEvent): EventIssueResolution {
  const raw = event.issue;
  if (!raw || typeof raw !== 'object') return { kind: 'invalid' };
  const fields = (raw as RawJiraIssue).fields;
  if (!fields || typeof fields !== 'object' || typeof fields.updated !== 'string') {
    return { kind: 'invalid' };
  }
  const hasCustomFields =
    event.customFieldsStatus === 'INCLUDED' &&
    event.customFields !== undefined &&
    event.customFields !== null &&
    typeof event.customFields === 'object';
  if (!hasCustomFields) return { kind: 'refetch' };
  return { kind: 'merged', raw: { ...raw, fields: { ...fields, ...event.customFields } } };
}

export async function handleIssueEvent(
  deps: ResolverDeps,
  event: JiraIssueEvent,
): Promise<EventResult> {
  const issueKey = event.issue?.key;

  if (event.eventType === DELETED) {
    // Deleted issues must leave the dashboard immediately; the
    // reconciling nightly scan is the backstop, not the mechanism
    // (cross-review B9 — the manifest now subscribes to this event).
    if (!issueKey) return { handled: false };
    await deps.store.deleteScore(issueKey);
    return { handled: true, issueKey };
  }

  if (!CREATED_OR_UPDATED.has(event.eventType) || !issueKey) {
    return { handled: false };
  }

  const resolution = resolveEventIssue(event);
  if (resolution.kind === 'invalid') {
    return { handled: false };
  }
  const fieldMap = await getEffectiveFieldMap(deps);
  const raw = resolution.kind === 'merged' ? resolution.raw : await deps.jira.getIssue(issueKey, fieldMap);
  const source = resolution.kind === 'merged' ? 'event' : 'rest';
  const issue = normalizeIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);

  // Cheap path: nothing score-relevant changed and the cached record
  // was computed under the current fingerprint. The provenance marker
  // (`source`) must be present — a record written before provenance
  // existed could be a degraded event score frozen forever by this
  // early-exit (cross-review A-NEW-3).
  const cached = await deps.store.getScore(issue.key);
  if (
    cached &&
    cached.source !== undefined &&
    cached.issueUpdated === issue.updated &&
    cached.settingsFingerprint === settingsFingerprint(settings, fieldMap)
  ) {
    return { handled: true, issueKey: issue.key };
  }

  await scoreAndStore(deps, issue, settings, fieldMap, source);
  return { handled: true, issueKey: issue.key };
}
