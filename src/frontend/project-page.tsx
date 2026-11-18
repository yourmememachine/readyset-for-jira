/**
 * ReadySet project dashboard (jira:projectPage, UI Kit).
 *
 * Project readiness at a glance: average score, % Ready, grade counts,
 * the 25 lowest-scoring open issues, a manual Rescan, and the
 * per-project settings (thresholds, per-check weights and toggles).
 * Data comes from the resolver functions in `src/functions/resolver.ts`.
 *
 * Scan model (cross-review round 3): the backend scans in bounded
 * chunks (one search page per resolver call). The page drives the scan
 * to completion by calling `continueScanProject` until the resolver
 * reports `complete`, showing progress instead of blocking on a spinner
 * that a 25 s invocation limit would kill mid-scan (B4). Failures are
 * rendered, never swallowed (B14). Settings are admin-gated (B13) and
 * threshold input is validated locally so an empty field can never
 * silently zero a threshold (A17).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  DynamicTable,
  Heading,
  Inline,
  Label,
  Link,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  Textfield,
  Toggle,
  useProductContext,
} from '@forge/react';
import type { ProjectDashboardPayload, ScanResult } from '../functions/resolver';
import { parseThresholdInput } from '../lib/threshold-input';
import { ALL_CHECK_IDS, CHECK_LABELS, DEFAULT_SETTINGS } from '../lib/rubric-config';
import type { CheckId, Grade, ProjectSettings } from '../lib/types';
import { toUserMessage } from '../lib/user-error';

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

/** Safety cap on chunk-continuation calls per user action. */
const MAX_SCAN_CHUNKS = 50;

function extractProjectKey(context: unknown): string | null {
  const extension = (context as { extension?: Record<string, unknown> } | undefined)
    ?.extension;
  const project = extension?.project as { key?: unknown } | undefined;
  return typeof project?.key === 'string' ? project.key : null;
}

function SettingsForm({
  projectKey,
  settings,
  canEdit,
  onSaved,
}: {
  projectKey: string;
  settings: ProjectSettings;
  canEdit: boolean;
  onSaved: (saved: ProjectSettings) => void;
}) {
  const [ready, setReady] = useState(String(settings.readyThreshold));
  const [almost, setAlmost] = useState(String(settings.almostThreshold));
  const [enabled, setEnabled] = useState<Record<CheckId, boolean>>({ ...settings.checksEnabled });
  const [weights, setWeights] = useState<Record<CheckId, string>>(() =>
    Object.fromEntries(ALL_CHECK_IDS.map((id) => [id, String(settings.weights[id])])) as Record<
      CheckId,
      string
    >,
  );
  const [sectionsText, setSectionsText] = useState(settings.improveSections.join(', '));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const adopt = (saved: ProjectSettings) => {
    // Adopt the resolver's normalized values so the form shows what
    // was actually stored (A17).
    setReady(String(saved.readyThreshold));
    setAlmost(String(saved.almostThreshold));
    setEnabled({ ...saved.checksEnabled });
    setWeights(
      Object.fromEntries(ALL_CHECK_IDS.map((id) => [id, String(saved.weights[id])])) as Record<
        CheckId,
        string
      >,
    );
    setSectionsText(saved.improveSections.join(', '));
  };

  const persist = async (next: ProjectSettings, successMessage: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const saved = await invoke<ProjectSettings>('saveSettings', { projectKey, settings: next });
      adopt(saved);
      setMessage(successMessage);
      onSaved(saved);
    } catch (err) {
      setMessage(toUserMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const readyValue = parseThresholdInput(ready);
    const almostValue = parseThresholdInput(almost);
    if (readyValue === null || almostValue === null) {
      // Local validation error — never sent to the resolver (A17).
      setMessage('Thresholds must be numbers between 0 and 100. Empty fields are not saved.');
      return;
    }
    const parsedWeights = {} as Record<CheckId, number>;
    for (const id of ALL_CHECK_IDS) {
      const value = parseThresholdInput(weights[id] ?? '');
      if (value === null || value < 0 || value > 100) {
        setMessage(`The weight for "${CHECK_LABELS[id]}" must be a number between 0 and 100.`);
        return;
      }
      parsedWeights[id] = value;
    }
    const parsedSections = sectionsText
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (parsedSections.length === 0) {
      setMessage('The Improve structure needs at least one section heading.');
      return;
    }
    await persist(
      {
        readyThreshold: readyValue,
        almostThreshold: almostValue,
        checksEnabled: enabled,
        weights: parsedWeights,
        improveSections: parsedSections,
      },
      'Settings saved. Issues rescore against the new rubric.',
    );
  };

  const reset = async () => {
    await persist(
      {
        readyThreshold: DEFAULT_SETTINGS.readyThreshold,
        almostThreshold: DEFAULT_SETTINGS.almostThreshold,
        checksEnabled: { ...DEFAULT_SETTINGS.checksEnabled },
        weights: { ...DEFAULT_SETTINGS.weights },
        improveSections: [...DEFAULT_SETTINGS.improveSections],
      },
      'Settings reset to the recommended rubric.',
    );
  };

  if (!canEdit) {
    const disabled = ALL_CHECK_IDS.filter((id) => !settings.checksEnabled[id]);
    return (
      <Stack space="space.100">
        <Heading size="small">Project settings</Heading>
        <Text>
          Ready threshold: {settings.readyThreshold} · Almost threshold:{' '}
          {settings.almostThreshold}. Only project administrators can change
          ReadySet settings.
        </Text>
        {disabled.length > 0 ? (
          <Text>Checks switched off in this project: {disabled.map((id) => CHECK_LABELS[id]).join(', ')}.</Text>
        ) : null}
      </Stack>
    );
  }

  return (
    <Stack space="space.100">
      <Heading size="small">Project settings</Heading>
      <Box>
        <Label labelFor="readyset-ready-threshold">Ready threshold (score ≥)</Label>
        <Textfield
          id="readyset-ready-threshold"
          type="number"
          value={ready}
          onChange={(event) => setReady(event.target.value)}
        />
      </Box>
      <Box>
        <Label labelFor="readyset-almost-threshold">Almost threshold (score ≥)</Label>
        <Textfield
          id="readyset-almost-threshold"
          type="number"
          value={almost}
          onChange={(event) => setAlmost(event.target.value)}
        />
      </Box>
      <Text>
        Every check can be weighted (0–100) or switched off. Scores renormalize over the
        checks that stay on, so the scale is always 0–100.
      </Text>
      {ALL_CHECK_IDS.map((id) => (
        <Inline key={id} space="space.100" alignBlock="center">
          <Toggle
            id={`readyset-toggle-${id}`}
            isChecked={enabled[id]}
            onChange={(event) =>
              setEnabled((current) => ({ ...current, [id]: event.target.checked ?? false }))
            }
          />
          <Label labelFor={`readyset-toggle-${id}`}>{CHECK_LABELS[id]}</Label>
          <Textfield
            id={`readyset-weight-${id}`}
            type="number"
            value={weights[id]}
            onChange={(event) =>
              setWeights((current) => ({ ...current, [id]: event.target.value }))
            }
          />
        </Inline>
      ))}
      <Box>
        <Label labelFor="readyset-improve-sections">Improve drafts toward these sections (comma-separated)</Label>
        <Textfield
          id="readyset-improve-sections"
          value={sectionsText}
          onChange={(event) => setSectionsText(event.target.value)}
        />
        <Text>
          One heading must contain "Acceptance criteria" — the rubric reads that section. If
          none does, it is added automatically.
        </Text>
      </Box>
      <Inline space="space.100">
        <Button appearance="primary" onClick={save} isDisabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </Button>
        <Button onClick={reset} isDisabled={saving}>
          Reset to recommended
        </Button>
      </Inline>
      {message ? <Text>{message}</Text> : null}
    </Stack>
  );
}

function ProjectPageApp() {
  const context = useProductContext();
  const projectKey = extractProjectKey(context);
  const [data, setData] = useState<ProjectDashboardPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [reloadCount, setReloadCount] = useState(0);

  const load = useCallback(() => {
    if (!projectKey) return;
    let cancelled = false;
    invoke<ProjectDashboardPayload>('getProjectDashboard', { projectKey })
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(toUserMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, reloadCount]);

  useEffect(load, [load]);

  if (!projectKey) {
    return (
      <SectionMessage title="ReadySet" appearance="warning">
        <Text>Open a project to see its readiness dashboard.</Text>
      </SectionMessage>
    );
  }
  if (error) {
    return (
      <SectionMessage title="ReadySet dashboard failed to load" appearance="error">
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

  const { stats, settings } = data;

  /** Drive a scan to completion chunk by chunk, then reload. */
  const driveScan = async (first: 'rescanProject' | 'continueScanProject') => {
    setRescanning(true);
    setActionError(null);
    try {
      let result = await invoke<ScanResult>(first, { projectKey });
      let guard = 0;
      while (!result.complete && guard < MAX_SCAN_CHUNKS) {
        result = await invoke<ScanResult>('continueScanProject', { projectKey });
        guard += 1;
      }
      setReloadCount((count) => count + 1);
    } catch (err) {
      // A failed scan must be visible, not a silent no-op (B14).
      setActionError(toUserMessage(err));
      setReloadCount((count) => count + 1);
    } finally {
      setRescanning(false);
    }
  };

  const scanFailed = data.scanStatus === 'failed';
  const scanIncomplete = data.scanStatus !== 'complete';

  return (
    <Box padding="space.300">
      <Stack space="space.300">
        <Heading size="large">ReadySet — {projectKey} readiness</Heading>
        {scanFailed ? (
          <SectionMessage title="The last scan of this project failed" appearance="error">
            <Text>
              {data.scanError ?? 'The scan did not complete.'} Scores below may be
              stale — use Rescan now to retry.
            </Text>
          </SectionMessage>
        ) : scanIncomplete ? (
          <SectionMessage title="Scan in progress" appearance="information">
            <Text>
              ReadySet is still scanning this project — showing{' '}
              {stats.openScored} scored open issues so far. The scan continues
              automatically; you can also press Rescan now.
            </Text>
          </SectionMessage>
        ) : null}
        {actionError ? (
          <SectionMessage title="Scan failed" appearance="error">
            <Text>{actionError}</Text>
          </SectionMessage>
        ) : null}
        {stats.openScored === 0 && data.scanStatus === 'complete' ? (
          <SectionMessage title="No open issues scored yet" appearance="information">
            <Text>
              ReadySet scores open issues in this project. Create or update an
              issue, or run a rescan, and readiness will appear here.
            </Text>
          </SectionMessage>
        ) : stats.openScored > 0 ? (
          <>
            <Inline space="space.300">
              <Stack space="space.050">
                <Heading size="medium">{stats.averageScore}</Heading>
                <Text>Average readiness (open issues)</Text>
              </Stack>
              <Stack space="space.050">
                <Heading size="medium">{stats.percentReady}%</Heading>
                <Text>Open issues Ready</Text>
              </Stack>
              <Stack space="space.050">
                <Heading size="medium">{stats.openScored}</Heading>
                <Text>Open issues scored</Text>
              </Stack>
            </Inline>
            <ProgressBar value={stats.averageScore / 100} />
            <Inline space="space.100">
              {(Object.keys(stats.counts) as Grade[]).map((grade) => (
                <Lozenge key={grade} appearance={GRADE_APPEARANCE[grade]}>
                  {`${GRADE_LABEL[grade]}: ${stats.counts[grade]}`}
                </Lozenge>
              ))}
            </Inline>
            <Heading size="small">Lowest-scoring open issues</Heading>
            <DynamicTable
              head={{
                cells: [
                  { key: 'issue', content: 'Issue' },
                  { key: 'summary', content: 'Summary' },
                  { key: 'status', content: 'Status' },
                  { key: 'score', content: 'Score' },
                  { key: 'grade', content: 'Grade' },
                ],
              }}
              rows={stats.worstOffenders.map((record) => ({
                key: record.issueKey,
                cells: [
                  {
                    key: 'issue',
                    content: <Link href={`/browse/${record.issueKey}`}>{record.issueKey}</Link>,
                  },
                  { key: 'summary', content: record.summary },
                  { key: 'status', content: record.statusName },
                  { key: 'score', content: String(record.score) },
                  {
                    key: 'grade',
                    content: (
                      <Lozenge appearance={GRADE_APPEARANCE[record.grade]}>
                        {GRADE_LABEL[record.grade]}
                      </Lozenge>
                    ),
                  },
                ],
              }))}
            />
          </>
        ) : null}
        <Text>
          Field map in use — story points: {data.fieldMap.storyPoints}, epic
          link: {data.fieldMap.epicLink}, acceptance criteria:{' '}
          {data.fieldMap.acceptanceCriteria ?? 'not configured (description section is used)'}.
        </Text>
        <Inline space="space.100">
          <Button
            appearance="primary"
            onClick={() => void driveScan(scanIncomplete && !scanFailed ? 'continueScanProject' : 'rescanProject')}
            isDisabled={rescanning}
          >
            {rescanning ? 'Scanning…' : scanFailed ? 'Retry scan' : 'Rescan now'}
          </Button>
        </Inline>
        <SettingsForm
          projectKey={projectKey}
          settings={settings}
          canEdit={data.canEditSettings}
          onSaved={() => setReloadCount((count) => count + 1)}
        />
      </Stack>
    </Box>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <ProjectPageApp />
  </React.StrictMode>,
);
