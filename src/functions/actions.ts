/**
 * ReadySet Coach actions (phase 2a, DESIGN.md §5.3 item 5).
 *
 * The three GET actions behind the `rovo:agent`. They are plain
 * dependency-injected functions over the same {@link ScoreStore} the
 * panel and dashboard read — one engine, four surfaces — and every
 * NUMBER they answer comes from stored scores, so an agent answer can
 * never invent a number ReadySet did not compute (DESIGN.md §5.1).
 * `src/index.ts` binds them to the manifest's action functions; tests
 * drive them with the in-memory store.
 *
 * Round 2 (D2 / E #1/#2 — the round's Blocker): stored records carry
 * no Jira permissions, and the action functions receive the invoking
 * user's context, so every answer is visibility-checked AS THAT USER
 * before a record is served: single-issue actions probe the issue
 * with an asUser read (fail closed, and "not visible" is
 * indistinguishable from "not scored"), and project actions require
 * BROWSE_PROJECTS and compute their aggregates over the subset of
 * issues the asker can actually see. The earlier "no Jira calls"
 * framing is retired — it was the vulnerability.
 */
import { computeProjectStats, isOpen } from '../lib/aggregate';
import { getVisibleIssueKeys } from '../lib/jira';
import { gradeForScore, projectedScoreIfFixed } from '../lib/rubric';
import type { ScanStatus } from '../lib/store';
import type { CheckResult, Grade, StoredScore } from '../lib/types';
import { canBrowseProject, requireValidProjectKey, type ResolverDeps } from './resolver';

/**
 * Whether the invoking user can see this issue, probed with an asUser
 * read. Any failure — 404, permission, network — is a "no": the
 * Coach never serves a record it could not verify the asker may see.
 */
async function canViewIssue(deps: ResolverDeps, issueKey: string): Promise<boolean> {
  const adapter = deps.jiraUser ?? deps.jira;
  try {
    await adapter.getIssue(issueKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * The records of a project the invoking user may see, or null when
 * the user may not browse the project at all / visibility could not
 * be established (callers then answer with their empty shape).
 * Aggregates are computed over this subset only (round 2, chair
 * ruling): filtering just the offender list would still leak the
 * score distribution of issues the asker cannot see.
 */
async function visibleProjectRecords(
  deps: ResolverDeps,
  projectKey: string,
): Promise<StoredScore[] | null> {
  if (!(await canBrowseProject(deps, projectKey))) return null;
  const adapter = deps.jiraUser ?? deps.jira;
  let visibleKeys: Set<string>;
  try {
    visibleKeys = await getVisibleIssueKeys(adapter, projectKey);
  } catch {
    return null;
  }
  const records = await deps.store.getProjectScores(projectKey);
  return records.filter((record) => visibleKeys.has(record.issueKey));
}

export interface IssueReadinessResult {
  found: boolean;
  issueKey: string;
  projectKey?: string;
  summary?: string;
  statusName?: string;
  score?: number;
  grade?: Grade;
  /** Per-check explanation: what was found and how to fix it. */
  checks?: Array<{
    id: CheckResult['id'];
    label: string;
    passed: boolean;
    detail: string;
    fixHint: string;
  }>;
  /** When ReadySet computed the score the answer is grounded in. */
  computedAt?: string;
}

export async function fetchIssueReadiness(
  deps: ResolverDeps,
  payload: { issueKey: string },
): Promise<IssueReadinessResult> {
  const record = await deps.store.getScore(payload.issueKey);
  if (!record) {
    // Honest empty answer: the Coach prompt instructs the agent to
    // report "not scored yet" for exactly this shape.
    return { found: false, issueKey: payload.issueKey };
  }
  if (!(await canViewIssue(deps, payload.issueKey))) {
    // Not visible to the asker (round 2, D2/E #1): answer exactly as
    // if unscored — confirming existence would itself leak.
    return { found: false, issueKey: payload.issueKey };
  }
  const settings = await deps.store.getSettings(record.projectKey);
  return {
    found: true,
    issueKey: record.issueKey,
    projectKey: record.projectKey,
    summary: record.summary,
    statusName: record.statusName,
    score: record.score,
    grade: gradeForScore(record.score, settings),
    checks: record.checks.map((check) => ({
      id: check.id,
      label: check.label,
      passed: check.passed,
      detail: check.detail,
      fixHint: check.fixHint,
    })),
    computedAt: record.computedAt,
  };
}

export interface ProjectReadinessResult {
  projectKey: string;
  /** False when nothing has been scored yet (agent says so, per prompt). */
  scored: boolean;
  totalScored: number;
  openScored: number;
  averageScore: number;
  percentReady: number;
  counts: Record<Grade, number>;
  scanStatus: ScanStatus | 'unknown';
  worstOffenders: Array<{
    issueKey: string;
    summary: string;
    score: number;
    grade: Grade;
  }>;
}

export async function fetchProjectReadiness(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<ProjectReadinessResult> {
  requireValidProjectKey(payload.projectKey);
  const visible = await visibleProjectRecords(deps, payload.projectKey);
  if (visible === null) {
    // No browse permission (or visibility unprovable): the empty
    // shape, indistinguishable from an unscored project (round 2).
    return {
      projectKey: payload.projectKey,
      scored: false,
      totalScored: 0,
      openScored: 0,
      averageScore: 0,
      percentReady: 0,
      counts: { ready: 0, almost: 0, 'not-ready': 0 },
      scanStatus: 'unknown',
      worstOffenders: [],
    };
  }
  const records = visible;
  const settings = await deps.store.getSettings(payload.projectKey);
  // Project readiness passes the records unfiltered (B20):
  // computeProjectStats applies the project's Done policy itself,
  // and pre-filtering silently overrode `donePolicy: 'include'` on
  // this surface — the Coach counted a different population than the
  // dashboard for the same project. (The round-2 visibility filter
  // above is a different axis: it removes records the ASKER may not
  // see, before any policy is applied.)
  const stats = computeProjectStats(payload.projectKey, records, settings, 5);
  const scanState = await deps.store.getScanState(payload.projectKey);
  return {
    projectKey: payload.projectKey,
    scored: records.length > 0,
    totalScored: stats.totalScored,
    openScored: stats.openScored,
    averageScore: stats.averageScore,
    percentReady: stats.percentReady,
    counts: stats.counts,
    scanStatus: scanState?.status ?? 'unknown',
    worstOffenders: stats.worstOffenders.map((record) => ({
      issueKey: record.issueKey,
      summary: record.summary,
      score: record.score,
      grade: record.grade,
    })),
  };
}

export interface FixFirstResult {
  projectKey: string;
  issues: Array<{
    issueKey: string;
    summary: string;
    score: number;
    grade: Grade;
    /** Highest-weight failing checks first — the fix order. */
    topFixes: Array<{ label: string; weight: number; fixHint: string }>;
  }>;
}

export interface SuggestedFixesResult {
  found: boolean;
  projectKey: string;
  issueKey?: string;
  summary?: string;
  score?: number;
  grade?: Grade;
  /** Every failing check with the score the issue would reach by fixing just it. */
  fixes?: Array<{
    label: string;
    fixHint: string;
    projectedScore: number;
    projectedGain: number;
  }>;
}

/**
 * "What should I fix next on the worst issue?" (Wave 3) — the single
 * lowest-scoring open issue with every failing check and the exact
 * projected gain of fixing each one alone, best gain first. All
 * numbers come from the stored score + the rubric's own projection.
 */
export async function fetchSuggestedFixes(
  deps: ResolverDeps,
  payload: { projectKey: string },
): Promise<SuggestedFixesResult> {
  requireValidProjectKey(payload.projectKey);
  const visible = await visibleProjectRecords(deps, payload.projectKey);
  if (visible === null) return { found: false, projectKey: payload.projectKey };
  const records = visible;
  const settings = await deps.store.getSettings(payload.projectKey);
  // Fix-first surfaces stay open-only under BOTH Done policies
  // (pinned by the actions B9 test): nominating a Done issue as the
  // next thing to fix is never actionable, whatever the dashboard
  // counts. Only fetchProjectReadiness follows the policy (B20).
  const stats = computeProjectStats(payload.projectKey, records.filter(isOpen), settings, 1);
  const worst = stats.worstOffenders[0];
  if (!worst) return { found: false, projectKey: payload.projectKey };
  const fixes = worst.checks
    .filter((check) => !check.passed)
    .map((check) => {
      const projected = projectedScoreIfFixed(worst.checks, check.id);
      return {
        label: check.label,
        fixHint: check.fixHint,
        projectedScore: projected,
        projectedGain: projected - worst.score,
      };
    })
    .sort((a, b) => b.projectedGain - a.projectedGain);
  return {
    found: true,
    projectKey: payload.projectKey,
    issueKey: worst.issueKey,
    summary: worst.summary,
    score: worst.score,
    grade: worst.grade,
    fixes,
  };
}

export interface CompareIssuesResult {
  found: boolean;
  missing?: string[];
  a?: IssueReadinessResult;
  b?: IssueReadinessResult;
  /** Checks where the two issues differ (pass/fail), with both outcomes. */
  differences?: Array<{
    label: string;
    /** null when the check does not apply to that issue (round 2,
     *  F-15) — the old `?? true` reported N/A as a pass, so a Bug
     *  missing repro steps compared equal to a Story. */
    aPassed: boolean | null;
    bPassed: boolean | null;
    aDetail: string;
    bDetail: string;
  }>;
}

/**
 * "Compare ABC-1 and ABC-2" (Wave 3) — both readiness answers plus
 * the checks where they actually differ, so the agent can explain a
 * score gap instead of reciting two full checklists.
 */
export async function fetchCompareIssues(
  deps: ResolverDeps,
  payload: { issueKeyA: string; issueKeyB: string },
): Promise<CompareIssuesResult> {
  const a = await fetchIssueReadiness(deps, { issueKey: payload.issueKeyA });
  const b = await fetchIssueReadiness(deps, { issueKey: payload.issueKeyB });
  const missing = [a, b].filter((result) => !result.found).map((result) => result.issueKey);
  if (missing.length > 0) return { found: false, missing };
  const aById = new Map((a.checks ?? []).map((check) => [check.id, check]));
  const bById = new Map((b.checks ?? []).map((check) => [check.id, check]));
  // Differences over the UNION of both checklists (B21):
  // iterating A's checks only hid a check that exists solely on B —
  // repro-steps on a Bug compared against a Story is exactly the
  // check that explains the score gap. A check one issue does not
  // carry is reported as not applicable on that side, never as a
  // silent pass.
  const allIds = [...new Set([...aById.keys(), ...bById.keys()])];
  const differences = allIds
    .filter((id) => {
      const checkA = aById.get(id);
      const checkB = bById.get(id);
      // A check only one side carries counts as a difference only
      // when that side FAILS it — a passing bug-only check explains
      // nothing about a score gap.
      if (!checkA) return checkB !== undefined && !checkB.passed;
      if (!checkB) return !checkA.passed;
      return checkA.passed !== checkB.passed;
    })
    .map((id) => {
      const checkA = aById.get(id);
      const checkB = bById.get(id);
      const either = checkA ?? checkB;
      return {
        label: either?.label ?? id,
        aPassed: checkA ? checkA.passed : null,
        bPassed: checkB ? checkB.passed : null,
        aDetail: checkA?.detail ?? 'This check does not apply to this issue.',
        bDetail: checkB?.detail ?? 'This check does not apply to this issue.',
      };
    });
  return { found: true, a, b, differences };
}

const DEFAULT_FIX_FIRST_LIMIT = 5;
const MAX_FIX_FIRST_LIMIT = 25;

/**
 * "What should I fix first?" — the project's lowest-scoring open
 * issues, each with its highest-weight failing checks and their
 * one-line fixes, in the order the Coach prompt ranks by.
 */
export async function fetchFixFirst(
  deps: ResolverDeps,
  payload: { projectKey: string; limit?: number },
): Promise<FixFirstResult> {
  requireValidProjectKey(payload.projectKey);
  const limit = Math.min(
    MAX_FIX_FIRST_LIMIT,
    Math.max(1, Math.floor(payload.limit ?? DEFAULT_FIX_FIRST_LIMIT) || DEFAULT_FIX_FIRST_LIMIT),
  );
  const visible = await visibleProjectRecords(deps, payload.projectKey);
  if (visible === null) return { projectKey: payload.projectKey, issues: [] };
  const records = visible;
  const settings = await deps.store.getSettings(payload.projectKey);
  // Open-only under both Done policies, as in fetchSuggestedFixes.
  const stats = computeProjectStats(payload.projectKey, records.filter(isOpen), settings, limit);
  return {
    projectKey: payload.projectKey,
    issues: stats.worstOffenders.map((record) => ({
      issueKey: record.issueKey,
      summary: record.summary,
      score: record.score,
      grade: record.grade,
      topFixes: record.checks
        .filter((check) => !check.passed)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 3)
        .map((check) => ({ label: check.label, weight: check.weight, fixHint: check.fixHint })),
    })),
  };
}
