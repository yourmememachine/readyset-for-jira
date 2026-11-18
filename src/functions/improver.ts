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
import { getEffectiveFieldMap, scoreAndStore, type ResolverDeps } from './resolver';

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
  } else {
    try {
      const markdown = await deps.llm.draftDescription({
        issue,
        failedChecks: failed,
        sections: settings.improveSections,
        mode,
      });
      sections =
        mode === 'ac-only'
          ? parseDraftMarkdown(markdown, [
              settings.improveSections.find((name) => /^acceptance criteria\b/i.test(name)) ??
                'Acceptance criteria',
            ])
          : parseDraftMarkdown(markdown, settings.improveSections);
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
  const fieldMap = await getEffectiveFieldMap(deps);
  const raw = await adapter.getIssue(payload.issueKey, fieldMap);
  const issue = readCompleteIssue(raw, fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const mode = payload.mode ?? 'full';
  const { draft, fromCache } = await draftForIssue(deps, issue, settings, { mode });
  const acSection = draft.sections[0];
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
  payload: { issueKey: string; contentHash: string; assignToMe?: boolean },
): Promise<ApplyPayload> {
  const readAdapter = deps.jiraUser ?? deps.jira;
  const fieldMap = await getEffectiveFieldMap(deps);
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
  // Governance gate (Wave 2): the write runs as the app, but Apply is
  // only offered to — and only honoured for — users who themselves
  // hold Edit issues in the project.
  if (!(await canUserEditIssues(deps, issue.projectKey))) {
    throw new Error(
      'You do not have permission to edit issues in this project, so the draft cannot be applied.',
    );
  }

  // The write itself runs as the app (DESIGN.md §5.1): the app holds
  // write:jira-work, and the comment below is the audit trail. An
  // AC-only draft merges its section into the live description —
  // everything else the author wrote stays untouched.
  if (mode === 'ac-only') {
    const acSection = draft.sections[0];
    if (!acSection) throw new Error('The draft for this issue is no longer available. Run Improve again.');
    await deps.jira.updateDescription(
      payload.issueKey,
      mergeAcSectionIntoAdf(raw.fields.description, acSection),
    );
  } else {
    await deps.jira.updateDescription(payload.issueKey, buildAdfFromSections(draft.sections));
  }

  // Rescore from the re-read issue so the reported jump — and the
  // stored score the dashboard and Coach read — is the real one. A
  // partial re-read throws here (after the write, before any store):
  // the previous stored score is kept rather than replaced by a
  // skeleton score, and the next event or scan heals the record.
  const after = readCompleteIssue(await deps.jira.getIssue(payload.issueKey, fieldMap), fieldMap);
  const record = await scoreAndStore(deps, after, settings, fieldMap, 'rest');

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
  await deps.jira.addComment(payload.issueKey, comment);

  // Improve & Assign (Wave 3): best-effort and after the fact — the
  // improvement already landed, so an assignment failure is reported
  // in the result, never thrown over a successful Apply.
  let assigned: boolean | undefined;
  let assignError: string | undefined;
  if (payload.assignToMe) {
    try {
      await (deps.jiraUser ?? deps.jira).assignToCurrentUser(payload.issueKey);
      assigned = true;
    } catch (err) {
      assigned = false;
      assignError = err instanceof Error ? err.message : String(err);
      console.error('ReadySet: assign-after-apply failed:', err);
    }
  }

  return {
    issueKey: payload.issueKey,
    previousScore: current.score,
    newScore: record.score,
    source: draft.source,
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
  const fieldMap = await getEffectiveFieldMap(deps);
  const issue = readCompleteIssue(await adapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
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
    try {
      const reply = await deps.llm.draftDescription({
        issue,
        failedChecks: scored.checks.filter((check) => !check.passed),
        kind: 'summary',
      });
      summary = parseSummaryReply(reply);
    } catch (err) {
      console.error('ReadySet: LLM summary failed, using derived fallback:', err);
      summary = buildSummaryFromIssue(issue);
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
  }
  return {
    issueKey: issue.key,
    canApply: await canUserEditIssues(deps, issue.projectKey),
    contentHash: draft.contentHash,
    source: draft.source,
    fromCache,
    currentSummary: issue.summary,
    suggestedSummary: draft.summary,
    currentScore: draft.scoreAtDraft,
    projectedScore: scoreIssue({ ...issue, summary: draft.summary }, settings).score,
  };
}

/** Apply a cached summary suggestion, with the same stale + permission gates as Apply. */
export async function applySummary(
  deps: ImproverDeps,
  payload: { issueKey: string; contentHash: string },
): Promise<ApplyPayload> {
  const readAdapter = deps.jiraUser ?? deps.jira;
  const fieldMap = await getEffectiveFieldMap(deps);
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
  if (!(await canUserEditIssues(deps, issue.projectKey))) {
    throw new Error(
      'You do not have permission to edit issues in this project, so the draft cannot be applied.',
    );
  }
  await deps.jira.updateSummary(payload.issueKey, draft.summary);
  const after = readCompleteIssue(await deps.jira.getIssue(payload.issueKey, fieldMap), fieldMap);
  const record = await scoreAndStore(deps, after, settings, fieldMap, 'rest');
  const comment = buildAdfFromSections([
    {
      heading: '',
      paragraphs: [`Summary improved with ReadySet — readiness ${current.score} → ${record.score}.`],
    },
  ]);
  await deps.jira.addComment(payload.issueKey, comment);
  return {
    issueKey: payload.issueKey,
    previousScore: current.score,
    newScore: record.score,
    source: draft.source,
  };
}
