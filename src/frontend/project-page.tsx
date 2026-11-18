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
  Select,
  Spinner,
  Stack,
  Text,
  Textfield,
  Toggle,
  useProductContext,
} from '@forge/react';
import type { ProjectDashboardPayload, ScanResult } from '../functions/resolver';
import type { BulkImproveResult } from '../functions/bulk-improve';
import { parseThresholdInput } from '../lib/threshold-input';
import { ALL_CHECK_IDS, CHECK_LABELS, DEFAULT_SETTINGS } from '../lib/rubric-config';
import type { CheckId, Grade, ProjectSettings } from '../lib/types';
import { toUserMessage } from '../lib/user-error';
import {
  filterOffenders,
  offenderFilterOptions,
  type OffenderFilter,
} from '../lib/dashboard-filters';

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

/** Safety cap on chunk-continuation calls per user action. 200 chunks
 *  at the round-2 UI page size of 25 covers a 5,000-issue project. */
const MAX_SCAN_CHUNKS = 200;

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
  const [excludedTypesText, setExcludedTypesText] = useState(settings.excludedIssueTypes.join(', '));
  const [excludedStatusesText, setExcludedStatusesText] = useState(
    settings.excludedStatuses.join(', '),
  );
  const [donePolicy, setDonePolicy] = useState(settings.donePolicy);
  const [analyticsEnabled, setAnalyticsEnabled] = useState(settings.analyticsEnabled);
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
    setExcludedTypesText(saved.excludedIssueTypes.join(', '));
    setExcludedStatusesText(saved.excludedStatuses.join(', '));
    setDonePolicy(saved.donePolicy);
    setAnalyticsEnabled(saved.analyticsEnabled);
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
    const splitList = (text: string): string[] =>
      text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    await persist(
      {
        readyThreshold: readyValue,
        almostThreshold: almostValue,
        checksEnabled: enabled,
        weights: parsedWeights,
        improveSections: parsedSections,
        excludedIssueTypes: splitList(excludedTypesText),
        excludedStatuses: splitList(excludedStatusesText),
        donePolicy,
        analyticsEnabled,
      },
      'Settings saved. Issues rescore against the new rubric.',
    );
  };

  const reset = () => {
    // Stage the recommended values into the form rather than saving
    // them on the spot (cross-review B7): the admin sees exactly what
    // will change and confirms with Save settings.
    adopt(DEFAULT_SETTINGS);
    setMessage('Form reset to the recommended values — press Save settings to apply them.');
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
          One heading must start with "Acceptance criteria" — the rubric reads that section. If
          none does, it is added automatically.
        </Text>
      </Box>
      <Box>
        <Label labelFor="readyset-excluded-types">Never score these issue types (comma-separated)</Label>
        <Textfield
          id="readyset-excluded-types"
          value={excludedTypesText}
          onChange={(event) => setExcludedTypesText(event.target.value)}
        />
      </Box>
      <Box>
        <Label labelFor="readyset-excluded-statuses">Never score issues in these statuses (comma-separated)</Label>
        <Textfield
          id="readyset-excluded-statuses"
          value={excludedStatusesText}
          onChange={(event) => setExcludedStatusesText(event.target.value)}
        />
        <Text>Excluded issues keep no ReadySet score and drop off the dashboard.</Text>
      </Box>
      <Box>
        <Label labelFor="readyset-done-policy">Done issues on the dashboard</Label>
        <Select
          id="readyset-done-policy"
          value={{
            label: donePolicy === 'include' ? 'Include Done issues in the statistics' : 'Exclude Done issues from the statistics',
            value: donePolicy,
          }}
          onChange={(option) => setDonePolicy(option.value === 'include' ? 'include' : 'exclude')}
          options={[
            { label: 'Exclude Done issues from the statistics', value: 'exclude' },
            { label: 'Include Done issues in the statistics', value: 'include' },
          ]}
        />
      </Box>
      <Inline space="space.100" alignBlock="center">
        <Toggle
          id="readyset-analytics"
          isChecked={analyticsEnabled}
          onChange={(event) => setAnalyticsEnabled(event.target.checked ?? false)}
        />
        <Label labelFor="readyset-analytics">
          Count usage in this site (scores computed, drafts, applies — last 7 days on the dashboard)
        </Label>
      </Inline>
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

/**
 * Bulk Improve (Wave 3): one admin click applies template drafts to
 * the five lowest-scoring open issues. Template-only by design (fast
 * and deterministic); per-issue results are listed, failures included.
 */
function BulkImproveSection({
  projectKey,
  onDone,
}: {
  projectKey: string;
  onDone: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BulkImproveResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const payload = await invoke<{ results: BulkImproveResult[] }>('bulkImprove', { projectKey });
      setResults(payload.results);
      onDone();
    } catch (err) {
      setError(toUserMessage(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center">
        <Button onClick={() => void run()} isDisabled={running}>
          {running ? 'Improving…' : 'Improve 3 lowest (template)'}
        </Button>
        <Text>
          Applies the built-in template draft to the three lowest-scoring open issues — the same
          checked Apply path as the panel, one click. Each issue also needs your Edit issues
          permission, and issues excluded in the settings above are skipped.
        </Text>
      </Inline>
      {error ? (
        <SectionMessage title="Bulk Improve did not complete" appearance="error">
          <Text>
            {error} Any issues already improved keep their changes and audit comments — reopen the
            dashboard to see current scores.
          </Text>
        </SectionMessage>
      ) : null}
      {results ? (
        results.length === 0 ? (
          <Text>No open issues below the Ready threshold — nothing to improve.</Text>
        ) : (
          <Stack space="space.050">
            {results.map((entry) => (
              <Text key={entry.issueKey}>
                {entry.error
                  ? `${entry.issueKey}: could not be improved — ${entry.error}`
                  : entry.skipped
                    ? `${entry.issueKey}: skipped — ${entry.skipped}`
                    : `${entry.issueKey}: readiness ${entry.previousScore} → ${entry.newScore}`}
              </Text>
            ))}
          </Stack>
        )
      ) : null}
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
  const [offenderFilter, setOffenderFilter] = useState<OffenderFilter>({});

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
              {stats.openScored} scored issues so far. Press Rescan now to
              continue the scan, or the nightly rescan will finish it.
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
                <Text>
                  {settings.donePolicy === 'include'
                    ? 'Average readiness (all scored issues)'
                    : 'Average readiness (open issues)'}
                </Text>
              </Stack>
              <Stack space="space.050">
                <Heading size="medium">{stats.percentReady}%</Heading>
                <Text>
                  {settings.donePolicy === 'include' ? 'Scored issues Ready' : 'Open issues Ready'}
                </Text>
              </Stack>
              <Stack space="space.050">
                <Heading size="medium">{stats.openScored}</Heading>
                <Text>
                  {settings.donePolicy === 'include' ? 'Issues scored' : 'Open issues scored'}
                </Text>
              </Stack>
              <Stack space="space.050">
                <Heading size="medium">{stats.becameReadyLast7Days.count}</Heading>
                <Text>
                  Became Ready in the last 7 days ({stats.becameReadyLast7Days.percent}% of
                  {settings.donePolicy === 'include' ? ' scored issues' : ' open issues'})
                </Text>
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
            {data.analytics ? (
              <Text>
                {`Usage counters, last 7 days in this site (approximate — automatic rescans count too): ${data.analytics.scores} scores computed · ${data.analytics.drafts} drafts generated · ${data.analytics.applies} improvements applied.`}
              </Text>
            ) : null}
            <Heading size="small">
              {settings.donePolicy === 'include'
                ? 'Lowest-scoring issues'
                : 'Lowest-scoring open issues'}
            </Heading>
            <OffenderFilters
              records={stats.worstOffenders}
              filter={offenderFilter}
              onChange={setOffenderFilter}
            />
            <DynamicTable
              emptyView={<Text>No issues in the lowest-scoring list match these filters.</Text>}
              head={{
                cells: [
                  { key: 'issue', content: 'Issue' },
                  { key: 'summary', content: 'Summary' },
                  { key: 'status', content: 'Status' },
                  { key: 'score', content: 'Score' },
                  { key: 'grade', content: 'Grade' },
                ],
              }}
              rows={filterOffenders(stats.worstOffenders, offenderFilter).map((record) => ({
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
        <SectionMessage title="How ReadySet works" appearance="information">
          <Text>
            ReadySet scores every open issue against a transparent rubric (description,
            acceptance criteria, estimate, links — plus reproduction steps for bugs) and
            mirrors each score into a Jira issue property, so JQL can find work that is
            not ready: readysetScore &lt; {settings.almostThreshold}. Improve drafts a
            better description from the issue's own facts and shows the projected score
            before applying. Project admins can retune thresholds, weights, and checks
            in the settings below. Support: tdilip2501@gmail.com (within 2 business days).
          </Text>
        </SectionMessage>
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
        {data.canEditSettings ? (
          <BulkImproveSection projectKey={projectKey} onDone={() => setReloadCount((count) => count + 1)} />
        ) : null}
        <SettingsForm
          key={JSON.stringify(settings)}
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

/**
 * Type / assignee / label filters over the worst-offenders table
 * (Wave 2). Options come from the loaded records themselves, so a
 * filter never offers a value nothing can match.
 */
function OffenderFilters({
  records,
  filter,
  onChange,
}: {
  records: ProjectDashboardPayload['stats']['worstOffenders'];
  filter: OffenderFilter;
  onChange: (next: OffenderFilter) => void;
}) {
  const options = offenderFilterOptions(records);
  const picker = (
    label: string,
    values: string[],
    current: string | undefined,
    apply: (value: string | undefined) => void,
  ) => (
    <Box>
      <Label labelFor={`readyset-filter-${label}`}>{label}</Label>
      <Select
        id={`readyset-filter-${label}`}
        options={[
          { label: 'All', value: '' },
          ...values.map((value) => ({ label: value, value })),
        ]}
        value={{ label: current ?? 'All', value: current ?? '' }}
        onChange={(selected) =>
          apply(selected && selected.value !== '' ? selected.value : undefined)
        }
      />
    </Box>
  );
  return (
    <Inline space="space.200">
      {picker('Type', options.issueTypes, filter.issueType, (issueType) =>
        onChange({ ...filter, issueType }),
      )}
      {picker('Assignee', options.assignees, filter.assignee, (assignee) =>
        onChange({ ...filter, assignee }),
      )}
      {picker('Label', options.labels, filter.label, (label) => onChange({ ...filter, label }))}
    </Inline>
  );
}
