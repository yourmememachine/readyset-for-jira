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
import { normalizeIssue } from '../lib/jira';
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

export interface ImproverDeps extends ResolverDeps {
  llm: LlmClient;
}

export interface ImprovePayload {
  issueKey: string;
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
export function improvementContentHash(issue: NormalizedIssue, failedChecks: CheckResult[]): string {
  const material = JSON.stringify({
    v: RUBRIC_VERSION,
    summary: issue.summary,
    descriptionText: issue.descriptionText,
    acceptanceCriteriaText: issue.acceptanceCriteriaText,
    failed: failedChecks.map((check) => check.id),
  });
  return createHash('sha256').update(material).digest('hex');
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
  const contentHash = improvementContentHash(issue, failed);
  const cached = await deps.store.getDraft(issue.key, contentHash);
  if (cached) return { draft: cached, fromCache: true };

  let sections: DraftSection[];
  let source: DraftSource;
  try {
    const markdown = await deps.llm.draftDescription({ issue, failedChecks: failed });
    sections = parseDraftMarkdown(markdown);
    source = 'llm';
  } catch (err) {
    // LLM unavailable / errored / unusable reply: the deterministic
    // template keeps Improve useful and the demo reproducible. The
    // failure is logged (never swallowed silently) so a live fallback
    // is diagnosable from `forge logs` — phase 2b's first live Improve
    // fell back with no trace, which is why this line exists.
    console.error('ReadySet: LLM draft failed, using template fallback:', err);
    sections = buildTemplateDraft(issue, failed);
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
  const issue = normalizeIssue(await adapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const { draft, fromCache } = await draftForIssue(deps, issue, settings);
  return {
    issueKey: issue.key,
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
  const issue = normalizeIssue(await readAdapter.getIssue(payload.issueKey, fieldMap), fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const current = scoreIssue(issue, settings);
  const failed = current.checks.filter((check) => !check.passed);
  if (improvementContentHash(issue, failed) !== payload.contentHash) {
    throw new Error(
      'This issue changed since the draft was generated. Run Improve again to refresh the draft.',
    );
  }
  const draft = await deps.store.getDraft(payload.issueKey, payload.contentHash);
  if (!draft) {
    throw new Error('The draft for this issue is no longer available. Run Improve again.');
  }

  // The write itself runs as the app (DESIGN.md §5.1): the app holds
  // write:jira-work, and the comment below is the audit trail.
  await deps.jira.updateDescription(payload.issueKey, buildAdfFromSections(draft.sections));

  // Rescore from the re-read issue so the reported jump — and the
  // stored score the dashboard and Coach read — is the real one.
  const after = normalizeIssue(await deps.jira.getIssue(payload.issueKey, fieldMap), fieldMap);
  const record = await scoreAndStore(deps, after, settings, fieldMap, 'rest');

  const comment = buildAdfFromSections([
    {
      heading: '',
      paragraphs: [
        `Description improved with ReadySet — readiness ${current.score} → ${record.score}.`,
      ],
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
