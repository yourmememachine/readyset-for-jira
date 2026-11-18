/**
 * Project-level statistics over stored scores. Pure: records in, stats
 * out. Grades are re-derived from the raw score against the *current*
 * settings thresholds, so changing a threshold in settings re-buckets
 * the dashboard without rescoreing every issue.
 */
import { gradeForScore } from './rubric';
import type { Grade, ProjectSettings, ProjectStats, StoredScore } from './types';

export function isOpen(record: StoredScore): boolean {
  return record.statusCategory !== 'done';
}

export function computeProjectStats(
  projectKey: string,
  records: StoredScore[],
  settings: ProjectSettings,
  worstLimit = 25,
): ProjectStats {
  const open = records.filter(isOpen);
  const counts: Record<Grade, number> = { ready: 0, almost: 0, 'not-ready': 0 };
  let sum = 0;
  for (const record of open) {
    counts[gradeForScore(record.score, settings)] += 1;
    sum += record.score;
  }
  const averageScore = open.length === 0 ? 0 : Math.round((sum / open.length) * 10) / 10;
  const percentReady =
    open.length === 0 ? 0 : Math.round((counts.ready / open.length) * 1000) / 10;
  const worstOffenders = [...open]
    .sort((a, b) => a.score - b.score || a.issueKey.localeCompare(b.issueKey))
    .slice(0, worstLimit)
    // Re-derive each grade against current thresholds so the table can
    // never disagree with the counts above after a settings change.
    .map((record) => ({ ...record, grade: gradeForScore(record.score, settings) }));
  return {
    projectKey,
    totalScored: records.length,
    openScored: open.length,
    averageScore,
    percentReady,
    counts,
    worstOffenders,
  };
}
