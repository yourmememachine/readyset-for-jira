/**
 * Forge function entry points (manifest handlers: index.handler,
 * index.eventHandler, index.scheduledHandler).
 *
 * This file only wires production adapters to the dependency-injected
 * handlers in `src/functions/` — all logic lives there and in `src/lib/`,
 * where it is unit-tested with fakes.
 */
import Resolver from '@forge/resolver';
import { ForgeJiraAdapter } from './lib/forge-jira';
import { ForgeKV } from './lib/forge-store';
import { ScoreStore } from './lib/store';
import { handleIssueEvent, type IssueEventPayload } from './functions/events';
import { handleScheduledRescan } from './functions/rescan';
import {
  getIssuePanel,
  getProjectDashboard,
  getSettings,
  rescanProject,
  saveSettings,
  type ResolverDeps,
} from './functions/resolver';

function buildDeps(): ResolverDeps {
  return {
    jira: new ForgeJiraAdapter(),
    store: new ScoreStore(new ForgeKV()),
  };
}

interface ResolverRequest<TPayload> {
  payload: TPayload;
}

const resolver = new Resolver();

resolver.define(
  'getIssuePanel',
  async ({ payload }: ResolverRequest<{ issueKey: string }>) =>
    getIssuePanel(buildDeps(), payload),
);

resolver.define(
  'getProjectDashboard',
  async ({ payload }: ResolverRequest<{ projectKey: string }>) =>
    getProjectDashboard(buildDeps(), payload),
);

resolver.define(
  'rescanProject',
  async ({ payload }: ResolverRequest<{ projectKey: string }>) =>
    rescanProject(buildDeps(), payload),
);

resolver.define(
  'getSettings',
  async ({ payload }: ResolverRequest<{ projectKey: string }>) =>
    getSettings(buildDeps(), payload),
);

resolver.define(
  'saveSettings',
  async ({
    payload,
  }: ResolverRequest<{
    projectKey: string;
    settings: Parameters<typeof saveSettings>[1]['settings'];
  }>) => saveSettings(buildDeps(), payload),
);

export const handler = resolver.getDefinitions();

export async function eventHandler(event: IssueEventPayload) {
  return handleIssueEvent(buildDeps(), event);
}

export async function scheduledHandler() {
  return handleScheduledRescan(buildDeps());
}
