/**
 * Bulk Improve (Wave 3): apply template drafts to a project's
 * lowest-scoring open issues in one admin action.
 *
 * Deliberately template-only: a bulk run must be deterministic and
 * fast (no per-issue model latency inside one resolver call), and the
 * dashboard labels it as such. Each issue goes through the exact same
 * draft → hash → permission-gated Apply path as the panel, so bulk
 * can never write anything the panel flow would refuse. Issues that
 * are already Ready are skipped — there is nothing to improve.
 */
import { isScoreablePayload, missingScoringFields, normalizeIssue } from '../lib/jira';
import { isOpen } from '../lib/aggregate';
import { applyImprovement, draftForIssue, type ImproverDeps } from './improver';
import { canAdminister, getEffectiveFieldMap, isExcluded } from './resolver';

export interface BulkImproveResult {
  issueKey: string;
  previousScore?: number;
  newScore?: number;
  error?: string;
  skipped?: string;
  /** The write landed but a post-write confirmation step failed (war-room B1). */
  warning?: string;
}

// Three, not five (cross-review B1): each issue costs ~16 sequential
// Jira/KVS round trips inside ONE resolver invocation, and Forge caps
// those at 25 seconds — a five-issue batch on a slow site could be
// killed mid-write. Three keeps the batch comfortably inside the cap.
const BULK_LIMIT = 3;

export async function bulkImproveTemplates(
  deps: ImproverDeps,
  payload: { projectKey: string },
): Promise<{ results: BulkImproveResult[] }> {
  if (!(await canAdminister(deps, payload.projectKey))) {
    throw new Error('Only project administrators can run bulk Improve.');
  }
  const settings = await deps.store.getSettings(payload.projectKey);
  const records = await deps.store.getProjectScores(payload.projectKey);
  const candidates = records
    .filter((record) => isOpen(record) && record.score < settings.readyThreshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, BULK_LIMIT);
  const fieldMap = await getEffectiveFieldMap(deps);
  // The pre-fetch reads as the invoking user, like every other UI
  // read (war-room A5 residual): Apply re-reads asUser before writing
  // in any case, so drafting from app-token data the admin cannot see
  // bought nothing and leaked restricted content into a KVS draft.
  const readAdapter = deps.jiraUser ?? deps.jira;
  const results: BulkImproveResult[] = [];
  for (const candidate of candidates) {
    try {
      const raw = await readAdapter.getIssue(candidate.issueKey, fieldMap);
      if (!isScoreablePayload(raw)) {
        throw new Error(
          `Incomplete issue payload (missing: ${missingScoringFields(raw, fieldMap).join(', ')})`,
        );
      }
      const issue = normalizeIssue(raw, fieldMap);
      if (isExcluded(issue, settings)) {
        // Excluded after it was scored (cross-review A2): bulk honours
        // the exclusion exactly like the panel does.
        results.push({ issueKey: candidate.issueKey, skipped: 'Excluded by the project settings.' });
        continue;
      }
      const { draft } = await draftForIssue(deps, issue, settings, { templateOnly: true });
      if (draft.scoreAtDraft >= settings.readyThreshold) {
        // The stored record was stale-low; the LIVE issue is already
        // Ready (cross-review A7). Never rewrite a healthy issue on a
        // stale record's say-so.
        results.push({
          issueKey: candidate.issueKey,
          skipped: `Already Ready at ${draft.scoreAtDraft} — the stored score was out of date.`,
        });
        continue;
      }
      const applied = await applyImprovement(deps, {
        issueKey: candidate.issueKey,
        contentHash: draft.contentHash,
      });
      results.push({
        issueKey: candidate.issueKey,
        previousScore: applied.previousScore,
        newScore: applied.newScore,
        ...(applied.postWriteWarning ? { warning: applied.postWriteWarning } : {}),
      });
    } catch (err) {
      results.push({
        issueKey: candidate.issueKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results };
}
