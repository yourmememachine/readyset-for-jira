/**
 * ReadySet Coach actions (phase 2a, DESIGN.md §5.3 item 5).
 *
 * The three GET actions behind the `rovo:agent`. They are plain
 * dependency-injected functions over the same {@link ScoreStore} the
 * panel and dashboard read — one engine, four surfaces — and they
 * answer ONLY from stored scores: no Jira calls, no LLM calls, so an
 * agent answer can never invent a number ReadySet did not compute
 * (DESIGN.md §5.1). `src/index.ts` binds them to the manifest's
 * action functions; tests drive them with the in-memory store.
 */
import { computeProjectStats } from '../lib/aggregate';
import { gradeForScore } from '../lib/rubric';
import type { ScanStatus } from '../lib/store';
import type { CheckResult, Grade } from '../lib/types';
import type { ResolverDeps } from './resolver';

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
  const records = await deps.store.getProjectScores(payload.projectKey);
  const settings = await deps.store.getSettings(payload.projectKey);
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
  const limit = Math.min(
    MAX_FIX_FIRST_LIMIT,
    Math.max(1, Math.floor(payload.limit ?? DEFAULT_FIX_FIRST_LIMIT) || DEFAULT_FIX_FIRST_LIMIT),
  );
  const records = await deps.store.getProjectScores(payload.projectKey);
  const settings = await deps.store.getSettings(payload.projectKey);
  const stats = computeProjectStats(payload.projectKey, records, settings, limit);
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
