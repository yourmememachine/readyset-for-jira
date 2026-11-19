/**
 * Improve flow (phase 2a, DESIGN.md §5.3 item 4): draft a rewritten
 * issue description, review it, apply it in place.
 *
 * `improveIssue` scores the issue, asks the injected {@link LlmClient}
 * for a draft, and caches the result by content hash in KVS. The LLM
 * never blocks the core: any failure — transport, quota, unusable
 * reply — falls back to the deterministic template
 * (`lib/improve-template.ts`), and the payload says honestly which
 * source produced the draft.
 *
 * `applyImprovement` is the app's only Jira write path. It refuses to
 * apply a draft whose content hash no longer matches the issue (the
 * issue changed underneath the reviewer), writes the ADF description
 * through the app adapter, rescores from the re-read issue, and posts
 * the audit comment with the real before/after scores.
 */
import { createHash } from 'node:crypto';
import {
  buildAdfFromSections,
  extractTextFromAdf,
  mergeAcSectionIntoAdf,
  sectionsFromAdf,
  type DraftSection,
} from '../lib/adf';
import { buildSummaryFromIssue, buildTemplateDraft, templateAcSection } from '../lib/improve-template';
import {
  incompleteScoringPayloadError,
  isScoreablePayload,
  missingScoringFields,
  normalizeIssue,
  type JiraFieldMap,
  type RawJiraIssue,
} from '../lib/jira';
import { parseDraftMarkdown, parseSummaryReply, type LlmClient } from '../lib/llm';
import { scoreIssue } from '../lib/rubric';
import { RUBRIC_VERSION } from '../lib/rubric-config';
import type {
  CheckResult,
  DraftSource,
  ImprovementDraft,
  ImproveMode,
  NormalizedIssue,
  ProjectSettings,
  SummaryDraft,
} from '../lib/types';
import { getEffectiveFieldMap, isExcluded, scoreAndStore, type ResolverDeps } from './resolver';

/**
 * Read an issue for drafting/applying, refusing partial payloads:
 * a draft computed against phantom failures — or a stored score
 * computed from a skeleton — is worse than no draft at all (the
 * completeness rule of the live RS-2 incident; see lib/jira.ts).
 */
function readCompleteIssue(raw: RawJiraIssue, fieldMap: JiraFieldMap): NormalizedIssue {
  if (!isScoreablePayload(raw)) {
    throw incompleteScoringPayloadError(raw.key, missingScoringFields(raw, fieldMap));
  }
  return normalizeIssue(raw, fieldMap);
}

export interface ImproverDeps extends ResolverDeps {
  llm: LlmClient;
}

export interface ImprovePayload {
  issueKey: string;
  /** Whether the viewing user may edit issues in this project — the
   *  panel disables Apply when false; applyImprovement re-checks. */
  canApply: boolean;
  /** Pass back to applyImprovement — proves the draft matches the issue. */
  contentHash: string;
  source: DraftSource;
  fromCache: boolean;
  sections: DraftSection[];
  /** The description's current sections (Wave 3 diff view). */
  currentSections: DraftSection[];
  /** Draft kind: full rewrite or Acceptance-criteria-only (Wave 3). */
  mode: ImproveMode;
  currentScore: number;
  /** Score the issue would get with this draft applied (same rubric). */
  projectedScore: number;
}

export interface ApplyPayload {
  issueKey: string;
  previousScore: number;
  newScore: number;
  source: DraftSource;
  /**
   * Set when the Jira write landed but a confirmation step after it
   * (re-read, rescore, audit comment) failed (B1). The apply
   * SUCCEEDED — this is a warning, not an error, and the UI must not
   * offer a retry of a write that already happened. When the rescore
   * itself failed, `newScore` repeats `previousScore` (unconfirmed).
   */
  postWriteWarning?: string;
  /** Improve & Assign outcome (Wave 3): attempted only when requested. */
  assigned?: boolean;
  assignError?: string;
}

export interface SummaryImprovePayload {
  issueKey: string;
  canApply: boolean;
  contentHash: string;
  source: DraftSource;
  fromCache: boolean;
  currentSummary: string;
  suggestedSummary: string;
  currentScore: number;
  projectedScore: number;
}

/**
 * Hash of everything a draft depends on: the issue's own content and
 * the set of failed checks it was drafted against, under the current
 * rubric version. Settings thresholds are deliberately excluded —
 * they change grades, not the draft's content targets.
 */
export function improvementContentHash(
  issue: NormalizedIssue,
  failedChecks: CheckResult[],
  sections: string[] = [],
  mode: ImproveMode = 'full',
): string {
  const material = JSON.stringify({
    v: RUBRIC_VERSION,
    summary: issue.summary,
    descriptionText: issue.descriptionText,
    acceptanceCriteriaText: issue.acceptanceCriteriaText,
    failed: failedChecks.map((check) => check.id),
    // Wave 2: the draft's target structure is part of what a draft
    // depends on — changing it must invalidate cached drafts.
    sections,
    // Wave 3: full and AC-only drafts of the same issue are different
    // drafts — the mode is part of the hash.
    mode,
  });
  return createHash('sha256').update(material).digest('hex');
}

/** Hash for summary suggestions (Wave 3): summary + the text it derives from. */
/**
 * The acceptance-criteria section of a draft, selected by heading —
 * never by position. The LLM parser tolerates preamble and extra
 * sections, so an AC-only draft's sections are NOT guaranteed to
 * start with the criteria; taking sections[0] merged the wrong text
 * into live descriptions (cross-review A1/B2).
 */
/**
 * Heading comparison normalizer (round 2, F-5): numbering,
 * bold markers and a trailing colon are presentation, not identity —
 * the same canonicalization parseDraftMarkdown applies to the
 * headings it stores, applied here to both sides of the comparison
 * so parser, rubric and this selector agree on what a heading IS.
 */
export function normalizeHeadingForMatch(heading: string): string {
  return heading
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .replace(/:\s*$/, '')
    .toLowerCase();
}

export function selectAcSection(sections: DraftSection[]): DraftSection | undefined {
  return sections.find((section) =>
    /^acceptance criteria\b/.test(normalizeHeadingForMatch(section.heading)),
  );
}

export function summaryContentHash(issue: NormalizedIssue): string {
  const material = JSON.stringify({
    v: RUBRIC_VERSION,
    kind: 'summary',
    summary: issue.summary,
    descriptionText: issue.descriptionText,
    acceptanceCriteriaText: issue.acceptanceCriteriaText,
  });
  return createHash('sha256').update(material).digest('hex');
}

const EDIT_ISSUES_PERMISSION = 'EDIT_ISSUES';

/** Max billed LLM draft calls per issue per day (round 2, E #12). */
export const LLM_DAILY_QUOTA_PER_ISSUE = 20;

/**
 * Whether the current user may edit issues in the project (Wave 2
 * governance): drafting is read-only and open to viewers, but Apply
 * rewrites the description, so it requires the user's own Edit
 * issues permission — checked as the user, fail-closed on error.
 */
export async function canUserEditIssues(
  deps: ImproverDeps,
  projectKey: string,
): Promise<boolean> {
  const adapter = deps.jiraUser ?? deps.jira;
  try {
    return await adapter.hasProjectPermission(projectKey, EDIT_ISSUES_PERMISSION);
  } catch {
    return false;
  }
}

function failedChecksOf(issue: NormalizedIssue, settings: ProjectSettings): CheckResult[] {
  return scoreIssue(issue, settings).checks.filter((check) => !check.passed);
}

/**
 * Rescore after a write (Apply paths). scoreAndStore returns null
 * when the issue is excluded by project settings — possible if an
 * admin excluded its type/status while a draft was open. The write
 * already landed, so report the rubric's own numbers without storing.
 */
async function rescoreAfterWrite(
  deps: ImproverDeps,
  after: NormalizedIssue,
  settings: ProjectSettings,
  fieldMap: JiraFieldMap,
  fieldMapDegraded = false,
): Promise<{ score: number; checks: CheckResult[] }> {
  if (fieldMapDegraded) {
    // Never persist a score computed on a never-resolved field map
    // (round 2, F-4): throwing here lands in the caller's post-write
    // warning channel — the write landed, the rescore is deferred to
    // the next event/scan.
    throw new Error('ReadySet: field map degraded; post-write rescore deferred');
  }
  const record = await scoreAndStore(deps, after, settings, fieldMap, 'rest');
  if (record) return record;
  const scored = scoreIssue(after, settings);
  return { score: scored.score, checks: scored.checks };
}

function projectedScore(
  issue: NormalizedIssue,
  sections: DraftSection[],
  settings: ProjectSettings,
): number {
  const draftText = extractTextFromAdf(buildAdfFromSections(sections));
  return scoreIssue({ ...issue, descriptionText: draftText }, settings).score;
}

/** Projected score for an AC-only draft: the rubric run over the merged description. */
function projectedAcOnlyScore(
  issue: NormalizedIssue,
  rawDescription: unknown,
  acSection: DraftSection,
  settings: ProjectSettings,
): number {
  const mergedText = extractTextFromAdf(mergeAcSectionIntoAdf(rawDescription, acSection));
  return scoreIssue({ ...issue, descriptionText: mergedText }, settings).score;
}

export interface DraftOptions {
  mode?: ImproveMode;
  /** Skip the LLM entirely (bulk actions — deterministic and fast). */
  templateOnly?: boolean;
}

export async function draftForIssue(
  deps: ImproverDeps,
  issue: NormalizedIssue,
  settings: ProjectSettings,
  options: DraftOptions = {},
): Promise<{ draft: ImprovementDraft; fromCache: boolean }> {
  const mode = options.mode ?? 'full';
  const scored = scoreIssue(issue, settings);
  const failed = scored.checks.filter((check) => !check.passed);
  const contentHash = improvementContentHash(issue, failed, settings.improveSections, mode);
  const cached = await deps.store.getDraft(issue.key, contentHash);
  if (cached) return { draft: cached, fromCache: true };

  let sections: DraftSection[];
  let source: DraftSource;
  if (options.templateOnly) {
    sections =
      mode === 'ac-only'
        ? [templateAcSection(issue, failed, settings.improveSections)]
        : buildTemplateDraft(issue, failed, settings.improveSections);
    source = 'template';
  } else if (
    (await deps.store.incrementLlmQuota(issue.key, deps.now ? deps.now() : new Date())) >
    LLM_DAILY_QUOTA_PER_ISSUE
  ) {
    // Daily LLM quota (round 2, E #12): drafting is open to any
    // viewer and every distinct content hash is a billed call, so
    // beyond the per-issue daily cap Improve serves the template —
    // the feature degrades, the cost does not grow.
    console.error(
      `ReadySet: LLM daily quota reached for ${issue.key}; using template fallback`,
    );
    sections =
      mode === 'ac-only'
        ? [templateAcSection(issue, failed, settings.improveSections)]
        : buildTemplateDraft(issue, failed, settings.improveSections);
    source = 'template';
  } else {
    try {
      const markdown = await deps.llm.draftDescription({
        issue,
        failedChecks: failed,
        sections: settings.improveSections,
        mode,
      });
      if (mode === 'ac-only') {
        const parsed = parseDraftMarkdown(
          markdown,
          [
            settings.improveSections.find((name) => /^acceptance criteria\b/i.test(name)) ??
              'Acceptance criteria',
          ],
          // The usability floor keys on draft kind (round 2, F-18): a
          // legitimate one-line AC section is ~35 chars and the
          // full-draft 40-char floor rejected every one of them.
          { minChars: 10 },
        );
        // Select the criteria section by heading, never by position:
        // the parser tolerates preamble and extra sections, and
        // merging sections[0] wrote the wrong text live (A1/B2). No
        // AC section in the reply → throw → template fallback.
        const ac = selectAcSection(parsed);
        if (!ac) {
          throw new Error('ReadySet: LLM ac-only reply had no acceptance-criteria section');
        }
        sections = [ac];
      } else {
        sections = parseDraftMarkdown(markdown, settings.improveSections);
      }
      source = 'llm';
    } catch (err) {
      // LLM unavailable / errored / unusable reply: the deterministic
      // template keeps Improve useful and the demo reproducible. The
      // failure is logged (never swallowed silently) so a live fallback
      // is diagnosable from `forge logs` — phase 2b's first live Improve
      // fell back with no trace, which is why this line exists.
      console.error('ReadySet: LLM draft failed, using template fallback:', err);
      sections =
        mode === 'ac-only'
          ? [templateAcSection(issue, failed, settings.improveSections)]
          : buildTemplateDraft(issue, failed, settings.improveSections);
      source = 'template';
    }
  }
  const draft: ImprovementDraft = {
    issueKey: issue.key,
    projectKey: issue.projectKey,
    contentHash,
    source,
    sections,
    scoreAtDraft: scored.score,
    generatedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    mode,
  };
  await deps.store.saveDraft(draft);
  if (settings.analyticsEnabled) {
    await deps.store.incrementAnalytics(issue.projectKey, 'drafts', deps.now ? deps.now() : new Date());
  }
  return { draft, fromCache: false };
}

/**
 * Draft (or fetch the cached draft of) an improved description for
 * one issue. Read-only against Jira — nothing is written until Apply.
 * Reads run as the viewing user (cross-review B12), like the panel.
 */
export async function improveIssue(
  deps: ImproverDeps,
  payload: { issueKey: string; mode?: ImproveMode },
): Promise<ImprovePayload> {
  const adapter = deps.jiraUser ?? deps.jira;
  const { fieldMap } = await getEffectiveFieldMap(deps);
  const raw = await adapter.getIssue(payload.issueKey, fieldMap);
  const issue = readCompleteIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  if (isExcluded(issue, settings)) {
    throw new Error(
      'This issue is excluded from ReadySet scoring by the project settings, so it cannot be improved here.',
    );
  }
  const mode = payload.mode ?? 'full';
  const { draft, fromCache } = await draftForIssue(deps, issue, settings, { mode });
  // Selected by heading, never by position (B2 hardening:
  // the old `?? draft.sections[0]` fallback is gone — construction
  // guarantees an AC-headed section in an ac-only draft, and a draft
  // without one is corrupt, not a cue to project the wrong section).
  const acSection = selectAcSection(draft.sections);
  if (mode === 'ac-only' && !acSection) {
    // Mirror Apply's refusal (round 2, F-19): a corrupt ac-only draft
    // is "no longer available", never silently projected as a full
    // draft — the preview previously showed full-mode numbers for a
    // draft Apply would refuse.
    throw new Error('The draft for this issue is no longer available. Run Improve again.');
  }
  return {
    issueKey: issue.key,
    canApply: await canUserEditIssues(deps, issue.projectKey),
    contentHash: draft.contentHash,
    source: draft.source,
    fromCache,
    sections: draft.sections,
    currentSections: sectionsFromAdf(raw.fields.description),
    mode,
    currentScore: draft.scoreAtDraft,
    projectedScore:
      mode === 'ac-only' && acSection
        ? projectedAcOnlyScore(issue, raw.fields.description, acSection, settings)
        : projectedScore(issue, draft.sections, settings),
  };
}

/**
 * Write a previously generated draft to the issue. The content hash
 * is re-derived from the live issue and must match the payload's —
 * a draft generated against older content is refused, never applied
 * over the top of newer edits.
 */
export async function applyImprovement(
  deps: ImproverDeps,
  payload: { issueKey: string; contentHash: string; assignToMe?: boolean; accountId?: string },
): Promise<ApplyPayload> {
  const readAdapter = deps.jiraUser ?? deps.jira;
  const { fieldMap, degraded } = await getEffectiveFieldMap(deps);
  const raw = await readAdapter.getIssue(payload.issueKey, fieldMap);
  const issue = readCompleteIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const current = scoreIssue(issue, settings);
  const failed = current.checks.filter((check) => !check.passed);
  // Load the draft first: its mode is part of the hash, so the stale
  // check re-derives with the mode the draft was created under.
  const draft = await deps.store.getDraft(payload.issueKey, payload.contentHash);
  if (!draft) {
    throw new Error('The draft for this issue is no longer available. Run Improve again.');
  }
  const mode = draft.mode ?? 'full';
  if (improvementContentHash(issue, failed, settings.improveSections, mode) !== payload.contentHash) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }
  // Exclusion gate at the single write path (cross-review A2): every
  // caller — panel, bulk — funnels through here, so an issue excluded
  // after its draft was generated can never be written by Apply.
  if (isExcluded(issue, settings)) {
    throw new Error(
      'This issue is excluded from ReadySet scoring by the project settings, so the draft cannot be applied.',
    );
  }
  // Governance gate (Wave 2): the write runs as the app, but Apply is
  // only offered to — and only honoured for — users who themselves
  // hold Edit issues in the project.
  if (!(await canUserEditIssues(deps, issue.projectKey))) {
    throw new Error(
      'You do not have permission to edit issues in this project, so the draft cannot be applied.',
    );
  }

  // Re-read immediately before the write (round 2, E7): the gates
  // above ran against a read taken several round trips ago, and a
  // concurrent edit landing in between was silently overwritten —
  // the stale-hash guarantee only held at Apply START. The re-read
  // re-derives the hash; a mismatch refuses exactly like the first
  // check. (Residual, documented: Jira REST offers no ETag/CAS, so a
  // write landing between this read and the PUT is still possible —
  // the window is now one round trip, not the whole Apply.)
  const freshRaw = await readAdapter.getIssue(payload.issueKey, fieldMap);
  const freshIssue = readCompleteIssue(freshRaw, fieldMap);
  const freshFailed = failedChecksOf(freshIssue, settings);
  if (
    improvementContentHash(freshIssue, freshFailed, settings.improveSections, mode) !==
    payload.contentHash
  ) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }

  // The write itself runs as the app (DESIGN.md §5.1): the app holds
  // write:jira-work, and the comment below is the audit trail. An
  // AC-only draft merges its section into the live description —
  // everything else the author wrote stays untouched.
  if (mode === 'ac-only') {
    // By heading, never by position — and no positional fallback
    // (B2): a stored draft with no AC-headed section is
    // corrupt; refuse it rather than merge whatever section is first
    // into the description as if it were the criteria.
    const acSection = selectAcSection(draft.sections);
    if (!acSection) throw new Error('The draft for this issue is no longer available. Run Improve again.');
    await deps.jira.updateDescription(
      payload.issueKey,
      mergeAcSectionIntoAdf(freshRaw.fields.description, acSection),
    );
  } else {
    await deps.jira.updateDescription(payload.issueKey, buildAdfFromSections(draft.sections));
  }

  // Improve & Assign (Wave 3): best-effort, but BEFORE the rescore —
  // assigning first lets the reported score and the audit comment
  // include the assignee check's points (live verification showed a
  // "65 → 65" comment on an issue the assignment had actually lifted
  // to 75). A failure is still only reported, never thrown over a
  // landed write.
  let assigned: boolean | undefined;
  let assignError: string | undefined;
  if (payload.assignToMe) {
    if (!payload.accountId) {
      // No invocation context to take the user from (e.g. a bulk or
      // scheduled call): report it, never guess an assignee.
      assigned = false;
      assignError = 'ReadySet could not resolve the current user from the request context.';
    } else {
      try {
        await (deps.jiraUser ?? deps.jira).assignToUser(payload.issueKey, payload.accountId);
        assigned = true;
      } catch (err) {
        assigned = false;
        assignError = err instanceof Error ? err.message : String(err);
        console.error('ReadySet: assign-after-apply failed:', err);
      }
    }
  }

  // The write has landed. Everything below is confirmation — the
  // re-read, the rescore, the audit comment — and a failure there
  // must never be reported as an Apply failure (B1): the
  // description HAS changed, and presenting a retryable error sends
  // the user into a retry the stale-hash check will refuse (their
  // own write changed the issue). Post-write failures therefore ride
  // back as a warning on a successful result. A partial re-read
  // still never stores a skeleton score: the previous stored score
  // is kept, and the next event or scan heals the record.
  let record: { score: number; checks: CheckResult[] } | null = null;
  let postWriteWarning: string | undefined;
  try {
    const after = readCompleteIssue(await deps.jira.getIssue(payload.issueKey, fieldMap), fieldMap);
    record = await rescoreAfterWrite(deps, after, settings, fieldMap, degraded);
  } catch (err) {
    console.error('ReadySet: post-apply rescore failed; the write itself landed:', err);
    postWriteWarning =
      'The description was updated, but ReadySet could not re-read the issue to confirm the new score. Reopen the issue to see it.';
  }
  if (record) {
    // Richer audit comment (Wave 2): name the checks that flipped, so
    // the trail shows WHY the score moved, not just that it did.
    const beforeById = new Map(current.checks.map((check) => [check.id, check.passed]));
    const flippedToPass = record.checks
      .filter((check) => check.passed && beforeById.get(check.id) === false)
      .map((check) => check.label);
    const flippedToFail = record.checks
      .filter((check) => !check.passed && beforeById.get(check.id) === true)
      .map((check) => check.label);
    const commentParagraphs = [
      mode === 'ac-only'
        ? `Acceptance criteria improved with ReadySet — readiness ${current.score} → ${record.score}.`
        : `Description improved with ReadySet — readiness ${current.score} → ${record.score}.`,
    ];
    if (flippedToPass.length > 0) {
      commentParagraphs.push(`Now passing: ${flippedToPass.join('; ')}.`);
    }
    if (flippedToFail.length > 0) {
      commentParagraphs.push(`No longer passing: ${flippedToFail.join('; ')}.`);
    }
    const comment = buildAdfFromSections([{ heading: '', paragraphs: commentParagraphs }]);
    try {
      await deps.jira.addComment(payload.issueKey, comment);
    } catch (err) {
      console.error('ReadySet: post-apply audit comment failed; the write itself landed:', err);
      postWriteWarning =
        'The description was updated and rescored, but the audit comment could not be posted.';
    }
  }
  // Post-write bookkeeping is guarded like everything after the
  // write (round 2, F-2): the analytics increment and the draft
  // consumption are KVS writes that can fail, and an unguarded throw
  // here reported a LANDED write as an Apply failure — inviting a
  // retry the stale-hash check would refuse.
  try {
    if (settings.analyticsEnabled) {
      await deps.store.incrementAnalytics(issue.projectKey, 'applies', deps.now ? deps.now() : new Date());
    }
    // The draft is consumed (B22): its hash is stale by
    // construction now, and leaving it in KVS only orphans it.
    await deps.store.deleteDraft(payload.issueKey, payload.contentHash);
  } catch (err) {
    console.error('ReadySet: post-apply bookkeeping failed; the write itself landed:', err);
    postWriteWarning ??=
      'The description was updated and rescored, but a final bookkeeping step failed.';
  }

  return {
    issueKey: payload.issueKey,
    previousScore: current.score,
    newScore: record?.score ?? current.score,
    source: draft.source,
    ...(postWriteWarning ? { postWriteWarning } : {}),
    ...(payload.assignToMe ? { assigned, assignError } : {}),
  };
}

/**
 * Draft (or fetch the cached) summary suggestion for one issue
 * (Wave 3). Same contract as description Improve: LLM first, derived
 * template on any failure; when neither can produce a specific
 * summary (an empty issue), the call fails with an honest message.
 */
export async function improveSummary(
  deps: ImproverDeps,
  payload: { issueKey: string },
): Promise<SummaryImprovePayload> {
  const adapter = deps.jiraUser ?? deps.jira;
  const { fieldMap } = await getEffectiveFieldMap(deps);
  const raw = await adapter.getIssue(payload.issueKey, fieldMap);
  const issue = readCompleteIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  if (isExcluded(issue, settings)) {
    throw new Error(
      'This issue is excluded from ReadySet scoring by the project settings, so it cannot be improved here.',
    );
  }
  const scored = scoreIssue(issue, settings);
  const contentHash = summaryContentHash(issue);
  const cached = await deps.store.getSummaryDraft(issue.key, contentHash);
  let draft: SummaryDraft;
  let fromCache = false;
  if (cached) {
    draft = cached;
    fromCache = true;
  } else {
    let summary: string | null = null;
    let source: DraftSource = 'llm';
    // Same per-issue daily LLM quota as description drafts (E #12).
    const overQuota =
      (await deps.store.incrementLlmQuota(issue.key, deps.now ? deps.now() : new Date())) >
      LLM_DAILY_QUOTA_PER_ISSUE;
    if (overQuota) {
      console.error(
        `ReadySet: LLM daily quota reached for ${issue.key}; using derived summary fallback`,
      );
      summary = buildSummaryFromIssue(issue, sectionsFromAdf(raw.fields.description));
      source = 'template';
    } else try {
      const reply = await deps.llm.draftDescription({
        issue,
        failedChecks: scored.checks.filter((check) => !check.passed),
        kind: 'summary',
      });
      summary = parseSummaryReply(reply);
    } catch (err) {
      console.error('ReadySet: LLM summary failed, using derived fallback:', err);
      summary = buildSummaryFromIssue(issue, sectionsFromAdf(raw.fields.description));
      source = 'template';
    }
    if (!summary) {
      throw new Error(
        'There is not enough text in this issue to suggest a better summary. Add a description first.',
      );
    }
    draft = {
      issueKey: issue.key,
      projectKey: issue.projectKey,
      contentHash,
      source,
      summary,
      scoreAtDraft: scored.score,
      generatedAt: (deps.now ? deps.now() : new Date()).toISOString(),
    };
    await deps.store.saveSummaryDraft(draft);
    if (settings.analyticsEnabled) {
      await deps.store.incrementAnalytics(issue.projectKey, 'drafts', deps.now ? deps.now() : new Date());
    }
  }
  return {
    issueKey: issue.key,
    canApply: await canUserEditIssues(deps, issue.projectKey),
    contentHash: draft.contentHash,
    source: draft.source,
    fromCache,
    currentSummary: issue.summary,
    suggestedSummary: draft.summary,
    // The LIVE score, not the draft-time one: a cached draft's
    // scoreAtDraft goes stale on any non-text change (estimate,
    // assignee) because the summary hash covers text only (A6).
    currentScore: scored.score,
    projectedScore: scoreIssue({ ...issue, summary: draft.summary }, settings).score,
  };
}

/** Apply a cached summary suggestion, with the same stale + permission gates as Apply. */
export async function applySummary(
  deps: ImproverDeps,
  payload: { issueKey: string; contentHash: string },
): Promise<ApplyPayload> {
  const readAdapter = deps.jiraUser ?? deps.jira;
  const { fieldMap, degraded } = await getEffectiveFieldMap(deps);
  const issue = readCompleteIssue(await readAdapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const current = scoreIssue(issue, settings);
  const draft = await deps.store.getSummaryDraft(payload.issueKey, payload.contentHash);
  if (!draft) {
    throw new Error('The draft for this issue is no longer available. Run Improve again.');
  }
  if (summaryContentHash(issue) !== payload.contentHash) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }
  if (isExcluded(issue, settings)) {
    throw new Error(
      'This issue is excluded from ReadySet scoring by the project settings, so the draft cannot be applied.',
    );
  }
  if (!(await canUserEditIssues(deps, issue.projectKey))) {
    throw new Error(
      'You do not have permission to edit issues in this project, so the draft cannot be applied.',
    );
  }
  // Re-read + hash recheck immediately before the write (round 2,
  // E7), exactly as in applyImprovement.
  const freshIssue = readCompleteIssue(
    await readAdapter.getIssue(payload.issueKey, fieldMap),
    fieldMap,
  );
  if (summaryContentHash(freshIssue) !== payload.contentHash) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }
  await deps.jira.updateSummary(payload.issueKey, draft.summary);
  // Post-write confirmation, guarded exactly as in applyImprovement
  // (B1): the summary HAS changed, so a re-read or comment
  // failure returns success with a warning, never a retryable error.
  let record: { score: number; checks: CheckResult[] } | null = null;
  let postWriteWarning: string | undefined;
  try {
    const after = readCompleteIssue(await deps.jira.getIssue(payload.issueKey, fieldMap), fieldMap);
    record = await rescoreAfterWrite(deps, after, settings, fieldMap, degraded);
  } catch (err) {
    console.error('ReadySet: post-apply rescore failed; the summary write itself landed:', err);
    postWriteWarning =
      'The summary was updated, but ReadySet could not re-read the issue to confirm the new score. Reopen the issue to see it.';
  }
  if (record) {
    const comment = buildAdfFromSections([
      {
        heading: '',
        paragraphs: [`Summary improved with ReadySet — readiness ${current.score} → ${record.score}.`],
      },
    ]);
    try {
      await deps.jira.addComment(payload.issueKey, comment);
    } catch (err) {
      console.error('ReadySet: post-apply audit comment failed; the summary write itself landed:', err);
      postWriteWarning =
        'The summary was updated and rescored, but the audit comment could not be posted.';
    }
  }
  // Guarded post-write bookkeeping (round 2, F-2), as in Apply.
  try {
    if (settings.analyticsEnabled) {
      await deps.store.incrementAnalytics(issue.projectKey, 'applies', deps.now ? deps.now() : new Date());
    }
    await deps.store.deleteSummaryDraft(payload.issueKey, payload.contentHash);
  } catch (err) {
    console.error('ReadySet: post-apply bookkeeping failed; the summary write itself landed:', err);
    postWriteWarning ??=
      'The summary was updated and rescored, but a final bookkeeping step failed.';
  }
  return {
    issueKey: payload.issueKey,
    previousScore: current.score,
    newScore: record?.score ?? current.score,
    source: draft.source,
    ...(postWriteWarning ? { postWriteWarning } : {}),
  };
}
