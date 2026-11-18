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
import { buildAdfFromSections, extractTextFromAdf, type DraftSection } from '../lib/adf';
import { buildTemplateDraft } from '../lib/improve-template';
import {
  incompleteScoringPayloadError,
  isScoreablePayload,
  missingScoringFields,
  normalizeIssue,
  type JiraFieldMap,
  type RawJiraIssue,
} from '../lib/jira';
import { parseDraftMarkdown, type LlmClient } from '../lib/llm';
import { scoreIssue } from '../lib/rubric';
import { RUBRIC_VERSION } from '../lib/rubric-config';
import type {
  CheckResult,
  DraftSource,
  ImprovementDraft,
  NormalizedIssue,
  ProjectSettings,
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
  currentScore: number;
  /** Score the issue would get with this draft applied (same rubric). */
  projectedScore: number;
}

export interface ApplyPayload {
  issueKey: string;
  previousScore: number;
  newScore: number;
  source: DraftSource;
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

async function draftForIssue(
  deps: ImproverDeps,
  issue: NormalizedIssue,
  settings: ProjectSettings,
): Promise<{ draft: ImprovementDraft; fromCache: boolean }> {
  const scored = scoreIssue(issue, settings);
  const failed = scored.checks.filter((check) => !check.passed);
  const contentHash = improvementContentHash(issue, failed, settings.improveSections);
  const cached = await deps.store.getDraft(issue.key, contentHash);
  if (cached) return { draft: cached, fromCache: true };

  let sections: DraftSection[];
  let source: DraftSource;
  try {
    const markdown = await deps.llm.draftDescription({
      issue,
      failedChecks: failed,
      sections: settings.improveSections,
    });
    sections = parseDraftMarkdown(markdown, settings.improveSections);
    source = 'llm';
  } catch (err) {
    // LLM unavailable / errored / unusable reply: the deterministic
    // template keeps Improve useful and the demo reproducible. The
    // failure is logged (never swallowed silently) so a live fallback
    // is diagnosable from `forge logs` — phase 2b's first live Improve
    // fell back with no trace, which is why this line exists.
    console.error('ReadySet: LLM draft failed, using template fallback:', err);
    sections = buildTemplateDraft(issue, failed, settings.improveSections);
    source = 'template';
  }
  const draft: ImprovementDraft = {
    issueKey: issue.key,
    projectKey: issue.projectKey,
    contentHash,
    source,
    sections,
    scoreAtDraft: scored.score,
    generatedAt: (deps.now ? deps.now() : new Date()).toISOString(),
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
  payload: { issueKey: string },
): Promise<ImprovePayload> {
  const adapter = deps.jiraUser ?? deps.jira;
  const fieldMap = await getEffectiveFieldMap(deps);
  const issue = readCompleteIssue(await adapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const { draft, fromCache } = await draftForIssue(deps, issue, settings);
  return {
    issueKey: issue.key,
    canApply: await canUserEditIssues(deps, issue.projectKey),
    contentHash: draft.contentHash,
    source: draft.source,
    fromCache,
    sections: draft.sections,
    currentScore: draft.scoreAtDraft,
    projectedScore: projectedScore(issue, draft.sections, settings),
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
  payload: { issueKey: string; contentHash: string },
): Promise<ApplyPayload> {
  const readAdapter = deps.jiraUser ?? deps.jira;
  const fieldMap = await getEffectiveFieldMap(deps);
  const issue = readCompleteIssue(await readAdapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const current = scoreIssue(issue, settings);
  const failed = current.checks.filter((check) => !check.passed);
  if (improvementContentHash(issue, failed, settings.improveSections) !== payload.contentHash) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }
  const draft = await deps.store.getDraft(payload.issueKey, payload.contentHash);
  if (!draft) {
    throw new Error('The draft for this issue is no longer available. Run Improve again.');
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
  // write:jira-work, and the comment below is the audit trail.
  await deps.jira.updateDescription(payload.issueKey, buildAdfFromSections(draft.sections));

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
    `Description improved with ReadySet — readiness ${current.score} → ${record.score}.`,
  ];
  if (flippedToPass.length > 0) {
    commentParagraphs.push(`Now passing: ${flippedToPass.join('; ')}.`);
  }
  if (flippedToFail.length > 0) {
    commentParagraphs.push(`No longer passing: ${flippedToFail.join('; ')}.`);
  }
  const comment = buildAdfFromSections([{ heading: '', paragraphs: commentParagraphs }]);
  await deps.jira.addComment(payload.issueKey, comment);

  return {
    issueKey: payload.issueKey,
    previousScore: current.score,
    newScore: record.score,
    source: draft.source,
  };
}
