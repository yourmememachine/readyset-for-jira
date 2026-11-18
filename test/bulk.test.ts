import { describe, expect, it } from 'vitest';
import { bulkImproveTemplates } from '../src/functions/bulk-improve';
import type { ImproverDeps } from '../src/functions/improver';
import { scanProject } from '../src/functions/resolver';
import { FakeJiraAdapter, type RawJiraIssue } from '../src/lib/jira';
import type { LlmClient } from '../src/lib/llm';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import { makeRawIssue, makeRawIssueNoEstimate, makeRawMessyIssue } from './fixtures';

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

const explodingLlm: LlmClient = {
  async draftDescription(): Promise<string> {
    throw new Error('bulk must never call the LLM');
  },
};

/** Seed via a real scan: RS-1 = 100, RS-2 = 90, RS-3 = 20. */
async function makeSeededDeps(issues: RawJiraIssue[]) {
  const store = new ScoreStore(new InMemoryKV());
  const jira = new FakeJiraAdapter(issues);
  const deps: ImproverDeps = { jira, store, llm: explodingLlm, now: () => FIXED_NOW };
  await scanProject({ jira, store, now: () => FIXED_NOW }, 'RS', { resume: false });
  return { deps, jira, store };
}

describe('bulkImproveTemplates (Wave 3)', () => {
  it('improves the lowest open issues with template drafts and reports each jump', async () => {
    const { deps, store } = await makeSeededDeps([
      makeRawIssue(),
      makeRawIssueNoEstimate(),
      makeRawMessyIssue(),
    ]);
    const { results } = await bulkImproveTemplates(deps, { projectKey: 'RS' });
    // RS-1 is Ready (100) and RS-2 is Ready at the default threshold
    // (90 ≥ 80) — only RS-3 is a candidate.
    expect(results).toEqual([{ issueKey: 'RS-3', previousScore: 20, newScore: 60 }]);
    expect((await store.getScore('RS-3'))?.score).toBe(60);
  });

  it('is admin-gated', async () => {
    const { deps, jira } = await makeSeededDeps([makeRawMessyIssue()]);
    jira.adminProjects = new Set<string>();
    await expect(bulkImproveTemplates(deps, { projectKey: 'RS' })).rejects.toThrow(
      /Only project administrators/,
    );
  });

  it('a per-issue failure is reported in its row, not thrown over the batch', async () => {
    const { deps, jira } = await makeSeededDeps([
      makeRawMessyIssue('RS-3'),
      makeRawMessyIssue('RS-4'),
    ]);
    // The user may not edit issues: every Apply is refused, and each
    // refusal lands in its own result row.
    jira.editProjects = new Set<string>();
    const { results } = await bulkImproveTemplates(deps, { projectKey: 'RS' });
    expect(results).toHaveLength(2);
    for (const entry of results) {
      expect(entry.error).toContain('do not have permission');
    }
  });
});
