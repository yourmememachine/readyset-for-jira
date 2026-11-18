/**
 * UI resolver handlers — the backend behind the issue panel and the
 * project dashboard.
 *
 * Handlers are plain async functions over injected dependencies
 * ({@link ResolverDeps}); `src/index.ts` binds them to `@forge/resolver`
 * with the production Jira/KVS adapters. Tests drive these exact
 * handlers with fakes, so what is tested is what ships.
 */
import { computeProjectStats } from '../lib/aggregate';
import {
  normalizeIssue,
  projectScanJql,
  type JiraAdapter,
  type JiraFieldMap,
} from '../lib/jira';
import { gradeForScore, scoreIssue } from '../lib/rubric';
import type { ScoreStore } from '../lib/store';
import type {
  CheckResult,
  Grade,
  NormalizedIssue,
  ProjectSettings,
  ProjectStats,
  StoredScore,
} from '../lib/types';

export interface ResolverDeps {
  jira: JiraAdapter;
  store: ScoreStore;
  fieldMap?: JiraFieldMap;
  now?: () => Date;
}

export interface IssuePanelPayload {
  issueKey: string;
  summary: string;
  statusName: string;
  score: number;
  grade: Grade;
  checks: CheckResult[];
  computedAt: string;
  fromCache: boolean;
}

export interface ProjectDashboardPayload {
  projectKey: string;
  stats: ProjectStats;
  settings: ProjectSettings;
}

export interface ScanResult {
  projectKey: string;
  scanned: number;
  resumedFrom: number;
}

const PAGE_SIZE = 100;

export function settingsFingerprint(settings: ProjectSettings): string {
  return JSON.stringify({
    ready: settings.readyThreshold,
    almost: settings.almostThreshold,
    estimate: settings.checksEnabled.estimate,
    dueDate: settings.checksEnabled['due-date'],
  });
}

function toStoredScore(
  issue: NormalizedIssue,
  settings: ProjectSettings,
  now: Date,
): StoredScore {
  const scored = scoreIssue(issue, settings);
  return {
    ...scored,
    projectKey: issue.projectKey,
    summary: issue.summary,
    statusName: issue.statusName,
    statusCategory: issue.statusCategory,
    issueUpdated: issue.updated,
    computedAt: now.toISOString(),
    settingsFingerprint: settingsFingerprint(settings),
  };
}

async function scoreAndStore(
  deps: ResolverDeps,
  issue: NormalizedIssue,
  settings: ProjectSettings,
): Promise<StoredScore> {
  const record = toStoredScore(issue, settings, deps.now ? deps.now() : new Date());
  await deps.store.saveScore(record);
  return record;
}

function panelPayload(record: StoredScore, settings: ProjectSettings, fromCache: boolean): IssuePanelPayload {
  return {
    issueKey: record.issueKey,
    summary: record.summary,
    statusName: record.statusName,
    score: record.score,
    // Grade is re-derived against current thresholds so a threshold edit
    // is reflected even on a cached score.
    grade: gradeForScore(record.score, settings),
    checks: record.checks,
    computedAt: record.computedAt,
    fromCache,
  };
}

/**
 * Panel data for one issue. Serves the cached score when the issue has
 * not changed and the project settings are unchanged since it was
 * computed; otherwise rescoring is one pure function call away.
 */
export async function getIssuePanel(
  deps: ResolverDeps,
  payload: { issueKey: string },
): Promise<IssuePanelPayload> {
  const raw = await deps.jira.getIssue(payload.issueKey);
  const issue = normalizeIssue(raw, deps.fieldMap);
  const settings = await deps.store.getSettings(issue.projectKey);
  const cached = await deps.store.getScore(issue.key);
  if (
    cached &&
    cached.issueUpdated === issue.updated &&
    cached.settingsFingerprint === settingsFingerprint(settings)
  ) {
    return panelPayload(cached, settings, true);
  }
  const record = await scoreAndStore(deps, issue, settings);
  return panelPayload(record, settings, false);
}

/**
 * Scan a project's open issues and (re)score every one of them.
 * Pages at 100 (the Jira search cap) and writes a KVS checkpoint after
 * each page, so if the invocation is cut short the next run resumes
 * where this one stopped instead of starting over.
 */
export async function scanProject(
  deps: ResolverDeps,
  projectKey: string,
  options: { resume: boolean },
): Promise<ScanResult> {
  const settings = await deps.store.getSettings(projectKey);
  const checkpoint = options.resume
    ? await deps.store.getRescanCheckpoint(projectKey)
    : undefined;
  const resumedFrom = checkpoint?.nextStartAt ?? 0;
  let startAt = resumedFrom;
  let scanned = 0;
  for (;;) {
    const page = await deps.jira.searchIssues(projectScanJql(projectKey), startAt, PAGE_SIZE);
    for (const raw of page.issues) {
      const issue = normalizeIssue(raw, deps.fieldMap);
      await scoreAndStore(deps, issue, settings);
      scanned += 1;
    }
    startAt += page.issues.length;
    if (page.issues.length === 0 || startAt >= page.total) {
      await deps.store.clearRescanCheckpoint(projectKey);
      break;
    }
    await deps.store.setRescanCheckpoint(projectKey, { nextStartAt: startAt });
  }
  await deps.store.markProjectScanned(projectKey);
  return { projectKey, scanned, resumedFrom };
}

/**
 * Dashboard data for one project. On first open (nothing scored yet)
 * the project is scanned inline so the page never renders empty when
 * the project actually has issues.
 */
export async function getProjectDashboard(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ProjectDashboardPayload> {
  // First open (project never scanned) populates inline; a project that
  // was scanned and simply has no open issues is not rescanned per open.
  if (!(await deps.store.hasProjectIndex(payload.projectKey))) {
    await scanProject(deps, payload.projectKey, { resume: true });
  }
  const records = await deps.store.getProjectScores(payload.projectKey);
  const settings = await deps.store.getSettings(payload.projectKey);
  const stats = computeProjectStats(payload.projectKey, records, settings);
  return { projectKey: payload.projectKey, stats, settings };
}

/** Manual "Rescan now" from the dashboard: always a full fresh scan. */
export async function rescanProject(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ScanResult> {
  await deps.store.clearRescanCheckpoint(payload.projectKey);
  return scanProject(deps, payload.projectKey, { resume: false });
}

export async function getSettings(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ProjectSettings> {
  return deps.store.getSettings(payload.projectKey);
}

function clampThreshold(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * Persist project settings. Thresholds are clamped into range and the
 * ordering almost ≤ ready is enforced here so a bad payload can never
 * store a settings object the rubric would misread.
 */
export async function saveSettings(
  deps: ResolverDeps,
  payload: { projectKey: string; settings: ProjectSettings },
): Promise<ProjectSettings> {
  const current = await deps.store.getSettings(payload.projectKey);
  const ready = clampThreshold(payload.settings.readyThreshold, current.readyThreshold);
  const almost = Math.min(
    ready,
    clampThreshold(payload.settings.almostThreshold, current.almostThreshold),
  );
  const next: ProjectSettings = {
    readyThreshold: ready,
    almostThreshold: almost,
    checksEnabled: {
      estimate: payload.settings.checksEnabled?.estimate ?? current.checksEnabled.estimate,
      'due-date':
        payload.settings.checksEnabled?.['due-date'] ?? current.checksEnabled['due-date'],
    },
  };
  await deps.store.saveSettings(payload.projectKey, next);
  return next;
}
