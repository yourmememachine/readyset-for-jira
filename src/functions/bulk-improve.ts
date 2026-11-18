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
import { canAdminister, getEffectiveFieldMap } from './resolver';

export interface BulkImproveResult {
  issueKey: string;
  previousScore?: number;
  newScore?: number;
  error?: string;
}

const BULK_LIMIT = 5;

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
  const results: BulkImproveResult[] = [];
  for (const candidate of candidates) {
    try {
      const raw = await deps.jira.getIssue(candidate.issueKey, fieldMap);
      if (!isScoreablePayload(raw)) {
        throw new Error(
          `Incomplete issue payload (missing: ${missingScoringFields(raw, fieldMap).join(', ')})`,
        );
      }
      const issue = normalizeIssue(raw, fieldMap);
      const { draft } = await draftForIssue(deps, issue, settings, { templateOnly: true });
      const applied = await applyImprovement(deps, {
        issueKey: candidate.issueKey,
        contentHash: draft.contentHash,
      });
      results.push({
        issueKey: candidate.issueKey,
        previousScore: applied.previousScore,
        newScore: applied.newScore,
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
