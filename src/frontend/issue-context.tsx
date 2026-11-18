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
import type { IssuePanelPayload } from '../functions/resolver';
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

function IssueContextApp() {
  const context = useProductContext();
  const issueKey = extractIssueKey(context);
  const [data, setData] = useState<IssuePanelPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshCount, setRefreshCount] = useState(0);

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
