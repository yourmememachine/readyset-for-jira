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
 *
 * The classification below learned a second lesson live (the RS-2
 * incident, 2026-11-17): 'INCLUDED' speaks only about the custom-
 * fields channel. For a single-field edit made in the Jira UI, the
 * event's `issue.fields` itself is SPARSE — headline fields only,
 * with description, assignee, labels, components, issuelinks,
 * parent, duedate and both estimate fields ABSENT (not null). The
 * old classifier merged that skeleton and scored it: RS-2 dropped
 * from a stored 90 to 35 (only the checks the skeleton could pass:
 * the edited estimate, priority, no-placeholders, summary, due
 * date). A merged payload is therefore scored directly ONLY when
 * it carries every standard scoring field (`isScoreablePayload`);
 * anything less is re-fetched in full, and a failed or still-
 * partial refetch keeps the previous stored score rather than
 * writing a partial one.
 */
import {
  isScoreablePayload,
  missingScoringFields,
  normalizeIssue,
  type RawJiraIssue,
} from '../lib/jira';
import type { ScoreSource } from '../lib/types';
import {
  getEffectiveFieldMap,
  clearExcludedProperty,
  scoreAndStore,
  settingsFingerprint,
  syncScoreProperty,
  type ResolverDeps,
} from './resolver';

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
 * - `merged` — custom fields were INCLUDED and the merged payload
 *   carries every standard field scoring reads; it may be scored
 *   directly. (Custom-field state needs no separate check: the
 *   INCLUDED map is authoritative for it — see lib/jira.ts.)
 * - `refetch` — the payload is well-formed but incomplete: custom
 *   fields omitted, OR the merged payload is missing standard
 *   scoring fields (the sparse field-edit shape of the RS-2
 *   incident). The issue must be re-fetched over REST.
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
  const merged: RawJiraIssue = { ...raw, fields: { ...fields, ...event.customFields } };
  // The merged payload may only be scored directly when it also
  // carries `issuetype`: the field is gate-exempt (its absence must
  // never refuse a payload outright), but scoring without it would
  // silently drop the bug pack and mint an inflated score that the
  // cache early-exits then freeze (upgrade cross-review A1). A
  // missing type therefore takes the refetch path, whose REST
  // request explicitly asks for the field (fieldsFor).
  return isScoreablePayload(merged) && merged.fields.issuetype !== undefined
    ? { kind: 'merged', raw: merged }
    : { kind: 'refetch' };
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
    // Round 2: the entity property and any cached drafts go too
    // (E #12) — a deleted issue's drafts were previously unreachable
    // garbage that never expired.
    if (!issueKey) return { handled: false };
    await deps.store.deleteScore(issueKey);
    await clearExcludedProperty(deps, issueKey);
    await deps.store.deleteIssueDrafts(issueKey);
    return { handled: true, issueKey };
  }

  if (!CREATED_OR_UPDATED.has(event.eventType) || !issueKey) {
    return { handled: false };
  }

  // Known-project gate (round 2, D9): the trigger fires for
  // every issue event on the SITE, but ReadySet only tracks projects
  // it has been used on (the roster). An event for any other project
  // is ignored before it can trigger a refetch or a KVS write. The
  // project key comes from the payload, falling back to the issue
  // key's prefix.
  const eventProjectKey =
    event.issue?.fields?.project?.key ?? issueKey.split('-')[0] ?? '';
  const knownProjects = await deps.store.getKnownProjects();
  if (!knownProjects.includes(eventProjectKey)) {
    return { handled: false };
  }

  const resolution = resolveEventIssue(event);
  if (resolution.kind === 'invalid') {
    return { handled: false };
  }
  const { fieldMap, degraded } = await getEffectiveFieldMap(deps);
  if (degraded) {
    // Persistence path (round 2, F-4): field resolution failed with
    // no cached map — keep the stored score rather than rescore on
    // never-resolved defaults.
    console.error(
      `ReadySet: event for ${issueKey} skipped; field resolution degraded, keeping the stored score`,
    );
    return { handled: false };
  }

  let raw: RawJiraIssue;
  let source: ScoreSource;
  if (resolution.kind === 'merged') {
    raw = resolution.raw;
    source = 'event';
  } else {
    // Refetch path: the event payload did not carry everything
    // scoring reads. A failed — or still partial — refetch keeps the
    // previous stored score untouched; writing a partial score over
    // a good one is the one outcome this handler must never produce
    // (live RS-2 incident).
    let fetched: RawJiraIssue;
    try {
      fetched = await deps.jira.getIssue(issueKey, fieldMap);
    } catch (err) {
      console.error(
        `ReadySet: event refetch for ${issueKey} failed; keeping the stored score:`,
        err,
      );
      return { handled: false };
    }
    if (!isScoreablePayload(fetched) || fetched.fields.issuetype === undefined) {
      // A refetch that still lacks a gated field — or the issue type,
      // without which a bug would be scored without its pack
      // (upgrade cross-review A1) — keeps the stored score.
      console.error(
        `ReadySet: event refetch for ${issueKey} returned an incomplete payload ` +
          `(missing: ${missingScoringFields(fetched, fieldMap).join(', ')}); keeping the stored score`,
      );
      return { handled: false };
    }
    raw = fetched;
    source = 'rest';
  }
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
    if (cached.propertySynced !== true) {
      // The record is fresh but its entity property never landed
      // (A1): the early-exit must not freeze the JQL mirror
      // in its failed state — retry the write on this event, which
      // already paid for the payload. The flip is conditional
      // (round 2, F-13).
      const synced = await syncScoreProperty(deps, cached, settings, cached);
      if (synced) {
        await deps.store.markPropertySynced(cached.issueKey, {
          score: cached.score,
          grade: cached.grade,
          computedAt: cached.computedAt,
        });
      }
    }
    return { handled: true, issueKey: issue.key };
  }

  await scoreAndStore(deps, issue, settings, fieldMap, source);
  return { handled: true, issueKey: issue.key };
}
