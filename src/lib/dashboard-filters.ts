/**
 * Worst-offender filters for the project dashboard (Wave 2). Pure:
 * the page loads the (capped) offender list once and filters it
 * locally as the admin picks a type, assignee, or label.
 */
import type { StoredScore } from './types';

export interface OffenderFilter {
  issueType?: string;
  assignee?: string;
  label?: string;
}

/** Filter sentinel for "unassigned" in the assignee picker. */
export const UNASSIGNED = '(unassigned)';

export function filterOffenders(records: StoredScore[], filter: OffenderFilter): StoredScore[] {
  return records.filter((record) => {
    if (filter.issueType && (record.issueType ?? 'Unknown') !== filter.issueType) return false;
    if (filter.assignee) {
      const assignee = record.assignee ?? UNASSIGNED;
      if (assignee !== filter.assignee) return false;
    }
    if (filter.label && !(record.labels ?? []).includes(filter.label)) return false;
    return true;
  });
}

export function offenderFilterOptions(records: StoredScore[]): {
  issueTypes: string[];
  assignees: string[];
  labels: string[];
} {
  const issueTypes = new Set<string>();
  const assignees = new Set<string>();
  const labels = new Set<string>();
  for (const record of records) {
    issueTypes.add(record.issueType ?? 'Unknown');
    assignees.add(record.assignee ?? UNASSIGNED);
    for (const label of record.labels ?? []) labels.add(label);
  }
  const sort = (values: Set<string>): string[] => [...values].sort((a, b) => a.localeCompare(b));
  return { issueTypes: sort(issueTypes), assignees: sort(assignees), labels: sort(labels) };
}
