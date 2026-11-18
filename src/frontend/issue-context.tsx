/**
 * ReadySet issue panel (jira:issueContext, UI Kit).
 *
 * Shows the readiness score for the issue being viewed, the grade, and
 * the per-check breakdown with a one-line fix for every failing check.
 * Data comes from the `getIssuePanel` resolver function.
 *
 * Freshness (cross-review B15): the panel subscribes to Jira's
 * issue-view events and refetches when the issue changes, so the footer
 * claim "Scores update automatically when the issue changes" is backed
 * by a mechanism, not just the backend trigger.
 *
 * Improve (phase 2b wiring): "Improve description" calls the
 * `improveIssue` resolver, shows the draft with its rubric-computed
 * projected score for review, and Apply calls `applyImprovement` —
 * which refuses a stale draft if the issue changed in the meantime —
 * then refetches so the panel shows the real post-Apply score. All
 * flow state and copy live in `lib/improve-flow.ts`.
 */
import React, { useEffect, useState } from 'react';
import { events, invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  Heading,
  Inline,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  useProductContext,
} from '@forge/react';
import type { ApplyPayload, ImprovePayload } from '../functions/improver';
import type { IssuePanelPayload } from '../functions/resolver';
import { nextFixFor, projectedScoreIfFixed } from '../lib/rubric';
import type { ScoreHistoryEntry } from '../lib/types';
import {
  applyFailed,
  applyLoaded,
  beginApply,
  beginDraft,
  discardDraft,
  draftFailed,
  draftLoaded,
  draftSourceLabel,
  formatScoreChange,
  initialImproveState,
  type ImproveFlowState,
} from '../lib/improve-flow';
import { toUserMessage } from '../lib/user-error';
import type { Grade } from '../lib/types';

const GRADE_LABEL: Record<Grade, string> = {
  ready: 'Ready',
  almost: 'Almost ready',
  'not-ready': 'Not ready',
};

const GRADE_APPEARANCE: Record<Grade, 'success' | 'inprogress' | 'removed'> = {
  ready: 'success',
  almost: 'inprogress',
  'not-ready': 'removed',
};

function extractIssueKey(context: unknown): string | null {
  const extension = (context as { extension?: Record<string, unknown> } | undefined)
    ?.extension;
  const issue = extension?.issue as { key?: unknown } | undefined;
  return typeof issue?.key === 'string' ? issue.key : null;
}

function ImproveSection({
  issueKey,
  state,
  setState,
  onApplied,
}: {
  issueKey: string;
  state: ImproveFlowState;
  setState: React.Dispatch<React.SetStateAction<ImproveFlowState>>;
  onApplied: () => void;
}) {
  const runImprove = async () => {
    setState((current) => beginDraft(current));
    try {
      const payload = await invoke<ImprovePayload>('improveIssue', { issueKey });
      setState((current) => draftLoaded(current, payload));
    } catch (err) {
      setState((current) => draftFailed(current, err));
    }
  };

  const runApply = async () => {
    const draft = state.draft;
    if (!draft) return;
    setState((current) => beginApply(current));
    try {
      const result = await invoke<ApplyPayload>('applyImprovement', {
        issueKey,
        contentHash: draft.contentHash,
      });
      setState((current) => applyLoaded(current, result));
      // Refetch the panel so the score on screen is the real,
      // post-Apply score the resolver just stored.
      onApplied();
    } catch (err) {
      setState((current) => applyFailed(current, err));
    }
  };

  switch (state.phase) {
    case 'idle':
      return (
        <Inline space="space.100">
          <Button appearance="primary" onClick={() => void runImprove()}>
            Improve description
          </Button>
        </Inline>
      );
    case 'drafting':
      return (
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" />
          <Text>Drafting an improved description…</Text>
        </Inline>
      );
    case 'review':
    case 'applying': {
      const draft = state.draft;
      if (!draft) return null;
      const applying = state.phase === 'applying';
      return (
        <Stack space="space.100">
          <SectionMessage title="Proposed description" appearance="information">
            <Stack space="space.100">
              <Text>
                Readiness {formatScoreChange(draft.currentScore, draft.projectedScore)} if
                applied. {draftSourceLabel(draft.source)}
                {draft.fromCache ? ' (cached draft)' : ''}
              </Text>
              {draft.sections.map((section, index) => (
                <Box key={`${section.heading}-${index}`}>
                  {section.heading ? (
                    <Heading size="small">{section.heading}</Heading>
                  ) : null}
                  {section.paragraphs.map((paragraph, paragraphIndex) => (
                    <Text key={paragraphIndex}>{paragraph}</Text>
                  ))}
                </Box>
              ))}
            </Stack>
          </SectionMessage>
          {state.message ? (
            <SectionMessage title="Apply failed" appearance="error">
              <Text>{state.message}</Text>
            </SectionMessage>
          ) : null}
          <Inline space="space.100">
            <Button
              appearance="primary"
              onClick={() => void runApply()}
              isDisabled={applying}
            >
              {applying ? 'Applying…' : 'Apply'}
            </Button>
            <Button
              onClick={() => setState((current) => discardDraft(current))}
              isDisabled={applying}
            >
              Discard
            </Button>
          </Inline>
        </Stack>
      );
    }
    case 'applied': {
      const result = state.applied;
      if (!result) return null;
      return (
        <Stack space="space.100">
          <SectionMessage title="Description updated" appearance="success">
            <Text>
              Readiness {result.previousScore} → {result.newScore}. A comment on
              the issue records the change.
            </Text>
          </SectionMessage>
          <Inline space="space.100">
            <Button onClick={() => void runImprove()}>Improve again</Button>
            <Button onClick={() => setState((current) => discardDraft(current))}>
              Dismiss
            </Button>
          </Inline>
        </Stack>
      );
    }
    case 'error':
      return (
        <Stack space="space.100">
          <SectionMessage title="Improve did not complete" appearance="error">
            <Text>{state.message ?? 'Something went wrong with Improve.'}</Text>
          </SectionMessage>
          <Inline space="space.100">
            <Button appearance="primary" onClick={() => void runImprove()}>
              Run Improve again
            </Button>
            <Button onClick={() => setState((current) => discardDraft(current))}>
              Dismiss
            </Button>
          </Inline>
        </Stack>
      );
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Latest score transition as a one-line history note (upgrade pack):
 * "Score history: 20 → 60 · Nov 17". Renders nothing until the score
 * has actually changed at least once.
 */
function historyLine(history: ScoreHistoryEntry[]) {
  if (history.length < 2) return null;
  const previous = history[history.length - 2];
  const latest = history[history.length - 1];
  if (!previous || !latest) return null;
  const at = new Date(latest.at);
  const when = Number.isNaN(at.getTime()) ? '' : ` · ${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return <Text>{`Score history: ${previous.score} → ${latest.score}${when}`}</Text>;
}

function IssueContextApp() {
  const context = useProductContext();
  const issueKey = extractIssueKey(context);
  const [data, setData] = useState<IssuePanelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);
  const [improve, setImprove] = useState<ImproveFlowState>(initialImproveState);

  // A draft belongs to one issue's content (its hash proves it); never
  // carry a draft across to a different issue.
  useEffect(() => {
    setImprove(initialImproveState);
  }, [issueKey]);

  useEffect(() => {
    if (!issueKey) return;
    let cancelled = false;
    setData(null);
    setError(null);
    invoke<IssuePanelPayload>('getIssuePanel', { issueKey })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toUserMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [issueKey, refreshCount]);

  // Refetch when Jira reports the issue changed while the panel is open.
  useEffect(() => {
    if (!issueKey) return;
    let subscription: { unsubscribe: () => void } | undefined;
    let active = true;
    events
      .on('JIRA_ISSUE_CHANGED', () => {
        if (active) setRefreshCount((count) => count + 1);
      })
      .then((sub) => {
        if (active) subscription = sub;
        else sub.unsubscribe();
      })
      .catch(() => {
        // Event subscription is a freshness nicety; the Refresh button
        // and the backend trigger still keep the panel correct.
      });
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [issueKey]);

  if (!issueKey) {
    return (
      <SectionMessage title="ReadySet" appearance="warning">
        <Text>Open an issue to see its readiness score.</Text>
      </SectionMessage>
    );
  }
  if (error) {
    return (
      <SectionMessage title="ReadySet could not score this issue" appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!data) {
    return (
      <Box padding="space.200">
        <Spinner size="medium" />
      </Box>
    );
  }

  const nextFix = nextFixFor(data.checks);
  const nextFixProjected = nextFix ? projectedScoreIfFixed(data.checks, nextFix.id) : null;

  return (
    <Box padding="space.200">
      <Stack space="space.200">
        <Inline space="space.100" alignBlock="center">
          <Heading size="large">{data.score}</Heading>
          <Lozenge appearance={GRADE_APPEARANCE[data.grade]}>
            {GRADE_LABEL[data.grade]}
          </Lozenge>
        </Inline>
        <ProgressBar value={data.score / 100} />
        {historyLine(data.history)}
        {nextFix && nextFixProjected !== null ? (
          <SectionMessage title={`Fix this next: ${nextFix.label} (+${nextFixProjected - data.score} pts → ${nextFixProjected})`} appearance="information">
            <Text>{nextFix.fixHint}</Text>
          </SectionMessage>
        ) : null}
        <Stack space="space.100">
          {data.checks.map((check) => (
            <Box key={check.id}>
              <Inline space="space.100" alignBlock="center">
                <Lozenge appearance={check.passed ? 'success' : 'removed'}>
                  {check.passed ? 'Pass' : 'Fix'}
                </Lozenge>
                <Text weight="bold">{check.label}</Text>
                <Text>({check.weight} pts)</Text>
              </Inline>
              <Text>{check.passed ? check.detail : check.fixHint}</Text>
            </Box>
          ))}
        </Stack>
        <ImproveSection
          issueKey={issueKey}
          state={improve}
          setState={setImprove}
          onApplied={() => setRefreshCount((count) => count + 1)}
        />
        <Inline space="space.100">
          <Button onClick={() => setRefreshCount((count) => count + 1)}>
            Refresh score
          </Button>
        </Inline>
        <Text>Scores update automatically when the issue changes.</Text>
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <IssueContextApp />
  </React.StrictMode>,
);
