/**
 * Improve → review → Apply flow state for the issue panel.
 *
 * The panel component (`frontend/issue-context.tsx`) owns the
 * `invoke()` calls; every transition and every user-facing string
 * lives here as pure functions so the flow is unit-testable without
 * rendering UI Kit (same split as `threshold-input.ts`).
 *
 * The backend contract is `functions/improver.ts`: `improveIssue`
 * returns a draft plus a content hash, `applyImprovement` re-derives
 * the hash from the live issue and refuses a stale draft. The error
 * mapping below turns those refusals into instructions the user can
 * act on — a stale draft is cleared (re-running Improve is the only
 * way forward), while a transient failure returns to the review
 * state with the draft intact so Apply can simply be retried.
 */
import type { ApplyPayload, ImprovePayload } from '../functions/improver';
import type { DraftSource } from './types';
import { toUserMessage } from './user-error';

export type ImprovePhase =
  | 'idle'
  | 'drafting'
  | 'review'
  | 'applying'
  | 'applied'
  | 'error';

export interface ImproveFlowState {
  phase: ImprovePhase;
  /** The draft under review (review / applying; kept on a retryable apply failure). */
  draft: ImprovePayload | null;
  /** The confirmed result of the last successful Apply. */
  applied: ApplyPayload | null;
  /** User-facing note for the current phase (error detail, retry hint). */
  message: string | null;
}

export const initialImproveState: ImproveFlowState = {
  phase: 'idle',
  draft: null,
  applied: null,
  message: null,
};

/**
 * True when the resolver refused because the draft no longer matches
 * the issue (it changed since drafting, or the cached draft expired).
 * Either way the draft is unusable — never offer a retry of Apply.
 */
export function isStaleDraftError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('changed since the draft') || message.includes('no longer available');
}

/**
 * Map an Improve/Apply failure to a sentence the user can act on.
 * Stale-draft refusals get their own copy; HTTP failures reuse the
 * shared resolver mapping (`user-error.ts`); anything else gets an
 * Improve-specific fallback instead of the data-loading one.
 */
export function toImproveMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('changed since the draft')) {
    return 'This issue changed since the draft was created, so the draft is out of date. Run Improve again to create a fresh draft.';
  }
  if (message.includes('no longer available')) {
    return 'That draft is no longer available. Run Improve again to create a new one.';
  }
  if (/HTTP \d{3}/.test(message)) {
    return toUserMessage(err);
  }
  return 'Something went wrong with Improve. Try again in a moment.';
}

/** Start drafting. Allowed from idle, applied (improve again), and error. */
export function beginDraft(state: ImproveFlowState): ImproveFlowState {
  if (state.phase !== 'idle' && state.phase !== 'applied' && state.phase !== 'error') {
    return state;
  }
  return { phase: 'drafting', draft: null, applied: null, message: null };
}

/** A draft arrived: move to review. */
export function draftLoaded(state: ImproveFlowState, draft: ImprovePayload): ImproveFlowState {
  if (state.phase !== 'drafting') return state;
  return { phase: 'review', draft, applied: null, message: null };
}

/** Drafting failed: error phase, no draft to fall back on. */
export function draftFailed(state: ImproveFlowState, err: unknown): ImproveFlowState {
  if (state.phase !== 'drafting') return state;
  return { phase: 'error', draft: null, applied: null, message: toImproveMessage(err) };
}

/** Discard the draft (or dismiss an error / a finished apply) back to idle. */
export function discardDraft(state: ImproveFlowState): ImproveFlowState {
  if (state.phase !== 'review' && state.phase !== 'error' && state.phase !== 'applied') {
    return state;
  }
  return { ...initialImproveState };
}

/** Apply clicked from the review state. */
export function beginApply(state: ImproveFlowState): ImproveFlowState {
  if (state.phase !== 'review' || !state.draft) return state;
  return { ...state, phase: 'applying', message: null };
}

/**
 * Apply succeeded. The draft is consumed; the panel refetches so the
 * score on screen becomes the real post-Apply score from the result.
 */
export function applyLoaded(state: ImproveFlowState, result: ApplyPayload): ImproveFlowState {
  if (state.phase !== 'applying') return state;
  return { phase: 'applied', draft: null, applied: result, message: null };
}

/**
 * Apply failed. A stale draft is gone for good (error phase, draft
 * cleared); anything else is retryable, so return to review with the
 * draft intact and the failure as a note.
 */
export function applyFailed(state: ImproveFlowState, err: unknown): ImproveFlowState {
  if (state.phase !== 'applying') return state;
  if (isStaleDraftError(err)) {
    return { phase: 'error', draft: null, applied: null, message: toImproveMessage(err) };
  }
  return { ...state, phase: 'review', message: toImproveMessage(err) };
}

/** "20 → 60 (+40)" — the score jump the review step promises, computed by the rubric. */
export function formatScoreChange(currentScore: number, projectedScore: number): string {
  const delta = projectedScore - currentScore;
  if (delta > 0) return `${currentScore} → ${projectedScore} (+${delta})`;
  if (delta < 0) return `${currentScore} → ${projectedScore} (${delta})`;
  return `${currentScore} → ${projectedScore} (no change)`;
}

/** Where the draft came from, in the panel's words. */
export function draftSourceLabel(source: DraftSource): string {
  return source === 'llm'
    ? 'AI-drafted description'
    : 'Template draft — the AI drafter was unavailable, so the built-in template wrote this instead.';
}
