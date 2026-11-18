/**
 * Nightly scheduled rescan (manifest: `scheduledTrigger`, interval day).
 *
 * Rescans every project ReadySet has seen (projects are registered in
 * KVS the first time any of their issues is scored). Each project's scan
 * resumes from its checkpoint if a previous run was cut short.
 */
import type { ResolverDeps, ScanResult } from './resolver';
import { scanProject } from './resolver';

export interface ScheduledRescanResult {
  projects: ScanResult[];
  totalScanned: number;
}

export async function handleScheduledRescan(
  deps: ResolverDeps,
): Promise<ScheduledRescanResult> {
  const projects = await deps.store.getKnownProjects();
  const results: ScanResult[] = [];
  let totalScanned = 0;
  for (const projectKey of projects) {
    const result = await scanProject(deps, projectKey, { resume: true });
    results.push(result);
    totalScanned += result.scanned;
  }
  return { projects: results, totalScanned };
}
