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
import { ForgeKV } from './lib/forge-store';
import { ScoreStore } from './lib/store';
import type { ProjectSettings } from './lib/types';
import { handleIssueEvent, type JiraIssueEvent } from './functions/events';
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

export const handler = resolver.getDefinitions();

/** Trigger entry point: issue created/updated/deleted events. */
export async function eventHandler(event: JiraIssueEvent): Promise<void> {
  await handleIssueEvent(backgroundDeps, event);
}

/** Scheduled entry point: nightly rescan of every known project. */
export async function scheduledHandler(): Promise<void> {
  await handleScheduledRescan(backgroundDeps);
}
