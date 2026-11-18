/**
 * Nightly scheduled rescan (`scheduledTrigger`, daily interval).
 *
 * Keeps stored scores fresh for issues that changed without firing an
 * event the app saw (bulk edits, imports, missed webhooks) and runs
 * the reconciling full scan per project, so closed/deleted records are
 * cleaned up daily.
 *
 * Properties (cross-review round 3):
 * - Every project is attempted: one project's failure is recorded and
 *   logged with its key, and the rest still run (A4/B11 — the old
 *   Promise.all aborted the whole night on the first failure).
 * - The roster rotates (A18): projects are visited starting after the
 *   last one that completed, so when the 900 s invocation budget cuts
 *   a run short, the tail of an alphabetical roster is not starved
 *   forever. Per-project checkpoints still resume mid-project.
 */
import { isValidProjectKey } from '../lib/jira';
import { scanProject, type ResolverDeps } from './resolver';

export interface ScheduledRescanResult {
  projects: Array<{ projectKey: string; scanned: number; complete: boolean }>;
  errors: Array<{ projectKey: string; error: string }>;
}

export async function handleScheduledRescan(deps: ResolverDeps): Promise<ScheduledRescanResult> {
  const known = await deps.store.getKnownProjects();
  // Legacy roster hygiene (round 2, F-16): a key planted before
  // validation existed is skipped and logged, never interpolated
  // into JQL by the scan sink.
  const valid: string[] = [];
  for (const projectKey of known) {
    if (isValidProjectKey(projectKey)) {
      valid.push(projectKey);
    } else {
      console.error(`ReadySet: nightly rescan skipping invalid roster key "${projectKey}"`);
    }
  }
  const roster = await rotateRoster(deps, valid);
  const projects: ScheduledRescanResult['projects'] = [];
  const errors: ScheduledRescanResult['errors'] = [];
  for (const projectKey of roster) {
    try {
      const result = await scanProject(deps, projectKey, { resume: true });
      projects.push({
        projectKey,
        scanned: result.scanned,
        complete: result.complete,
      });
      if (result.complete) {
        await deps.store.setRosterCheckpoint({ lastCompletedProject: projectKey });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`ReadySet: nightly rescan failed for project ${projectKey}: ${message}`);
      errors.push({ projectKey, error: message });
    }
  }
  return { projects, errors };
}

/** Order projects so the run starts after the last completed one. */
async function rotateRoster(deps: ResolverDeps, known: string[]): Promise<string[]> {
  if (known.length < 2) return known;
  const checkpoint = await deps.store.getRosterCheckpoint();
  const last = checkpoint?.lastCompletedProject;
  if (!last) return known;
  const index = known.indexOf(last);
  if (index < 0) return known;
  return [...known.slice(index + 1), ...known.slice(0, index + 1)];
}
