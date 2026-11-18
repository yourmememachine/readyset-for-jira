/**
 * Forge function entry points (manifest handlers: index.handler,
 * index.eventHandler, index.scheduledHandler).
 *
 * This file only wires production adapters to the dependency-injected
 * handlers in `src/functions/` — all logic lives there and in `src/lib/`,
 * where it is unit-tested with fakes.
 *
 * Adapter modes (cross-review B12): UI resolver functions read through
 * an asUser adapter so panels never surface issues the viewer cannot
 * see in Jira; triggers and the scheduled rescan run asApp.
 */
import Resolver from '@forge/resolver';
import { ForgeJiraAdapter } from './lib/forge-jira';
import { ForgeLlmClient } from './lib/forge-llm';
import { ForgeKV } from './lib/forge-store';
import { ScoreStore } from './lib/store';
import type { ProjectSettings } from './lib/types';
import {
  fetchCompareIssues,
  fetchFixFirst,
  fetchIssueReadiness,
  fetchProjectReadiness,
  fetchSuggestedFixes,
} from './functions/actions';
import { bulkImproveTemplates } from './functions/bulk-improve';
import { handleIssueEvent, type JiraIssueEvent } from './functions/events';
import {
  applyImprovement,
  applySummary,
  improveIssue,
  improveSummary,
  type ImproverDeps,
} from './functions/improver';
import { handleScheduledRescan } from './functions/rescan';
import {
  continueScanProject,
  getIssuePanel,
  getProjectDashboard,
  getSettings,
  rescanProject,
  saveSettings,
  type ResolverDeps,
} from './functions/resolver';

const store = new ScoreStore(new ForgeKV());

const uiDeps: ResolverDeps = {
  jira: new ForgeJiraAdapter('app'),
  jiraUser: new ForgeJiraAdapter('user'),
  store,
};

const backgroundDeps: ResolverDeps = {
  jira: new ForgeJiraAdapter('app'),
  store,
};

const improverDeps: ImproverDeps = {
  ...uiDeps,
  llm: new ForgeLlmClient(),
};

const resolver = new Resolver();

resolver.define(
  'getIssuePanel',
  async (request: { payload: { issueKey: string } }) => getIssuePanel(uiDeps, request.payload),
);

resolver.define(
  'getProjectDashboard',
  async (request: { payload: { projectKey: string } }) =>
    getProjectDashboard(uiDeps, request.payload),
);

resolver.define(
  'rescanProject',
  async (request: { payload: { projectKey: string } }) => rescanProject(uiDeps, request.payload),
);

resolver.define(
  'continueScanProject',
  async (request: { payload: { projectKey: string } }) =>
    continueScanProject(uiDeps, request.payload),
);

resolver.define(
  'getSettings',
  async (request: { payload: { projectKey: string } }) => getSettings(uiDeps, request.payload),
);

resolver.define(
  'saveSettings',
  async (request: { payload: { projectKey: string; settings: ProjectSettings } }) =>
    saveSettings(uiDeps, request.payload),
);

resolver.define(
  'improveIssue',
  async (request: { payload: { issueKey: string; mode?: 'full' | 'ac-only' } }) =>
    improveIssue(improverDeps, request.payload),
);

resolver.define(
  'applyImprovement',
  async (request: {
    payload: { issueKey: string; contentHash: string; assignToMe?: boolean };
    context?: { accountId?: string };
  }) =>
    applyImprovement(improverDeps, {
      ...request.payload,
      // Improve & Assign: the assignee is the invoking user, taken
      // from the resolver context — no /myself call (it needs a scope
      // this app does not declare; see forge-jira.ts).
      accountId: request.context?.accountId,
    }),
);

resolver.define(
  'improveSummary',
  async (request: { payload: { issueKey: string } }) =>
    improveSummary(improverDeps, request.payload),
);

resolver.define(
  'applySummary',
  async (request: { payload: { issueKey: string; contentHash: string } }) =>
    applySummary(improverDeps, request.payload),
);

resolver.define(
  'bulkImprove',
  async (request: { payload: { projectKey: string } }) =>
    bulkImproveTemplates(improverDeps, request.payload),
);

export const handler = resolver.getDefinitions();

/**
 * Rovo action entry points (manifest `action` modules → ReadySet
 * Coach). Actions run without a viewing-user context, so they use
 * the app deps; they only ever read stored scores (functions/actions).
 */
export async function fetchIssueReadinessAction(payload: { issueKey: string }) {
  return fetchIssueReadiness(backgroundDeps, payload);
}

export async function fetchProjectReadinessAction(payload: { projectKey: string }) {
  return fetchProjectReadiness(backgroundDeps, payload);
}

export async function fetchFixFirstAction(payload: { projectKey: string; limit?: number }) {
  return fetchFixFirst(backgroundDeps, payload);
}

export async function fetchSuggestedFixesAction(payload: { projectKey: string }) {
  return fetchSuggestedFixes(backgroundDeps, payload);
}

export async function fetchCompareIssuesAction(payload: {
  issueKeyA: string;
  issueKeyB: string;
}) {
  return fetchCompareIssues(backgroundDeps, payload);
}

/** Trigger entry point: issue created/updated/deleted events. */
export async function eventHandler(event: JiraIssueEvent): Promise<void> {
  await handleIssueEvent(backgroundDeps, event);
}

/** Scheduled entry point: nightly rescan of every known project. */
export async function scheduledHandler(): Promise<void> {
  await handleScheduledRescan(backgroundDeps);
}
