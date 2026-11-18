import { describe, expect, it } from 'vitest';
import {
  applyImprovement,
  improvementContentHash,
  improveIssue,
  type ImproverDeps,
} from '../src/functions/improver';
import { buildAdfFromSections, extractTextFromAdf } from '../src/lib/adf';
import { buildTemplateDraft } from '../src/lib/improve-template';
import { FakeJiraAdapter, normalizeIssue, type RawJiraIssue } from '../src/lib/jira';
import type { DraftRequest, LlmClient } from '../src/lib/llm';
import { scoreIssue } from '../src/lib/rubric';
import { InMemoryKV, ScoreStore } from '../src/lib/store';
import { LONG_DESCRIPTION, makeIssue, makeRawMessyIssue } from './fixtures';

const FIXED_NOW = new Date('2026-11-17T12:00:00.000Z');

class FakeLlmClient implements LlmClient {
  readonly calls: DraftRequest[] = [];
  constructor(private readonly behaviour: (request: DraftRequest) => string) {}
  async draftDescription(request: DraftRequest): Promise<string> {
    this.calls.push(request);
    return this.behaviour(request);
  }
}

const GOOD_MARKDOWN = [
  '## Goal',
  'Add token-bucket rate limiting to the public API gateway so that a single noisy integration cannot degrade latency for every other merchant on the platform.',
  '',
  '## Acceptance criteria',
  '- Requests beyond the configured quota return HTTP 429 with a Retry-After header.',
  '- Quota is configurable per API key without a deploy.',
  '- Metrics expose rejected-request counts per API key.',
].join('\n');

function makeImproverDeps(issues: RawJiraIssue[], llm: LlmClient, store?: ScoreStore) {
  const jira = new FakeJiraAdapter(issues);
  const deps: ImproverDeps = {
    jira,
    store: store ?? new ScoreStore(new InMemoryKV()),
    llm,
    now: () => FIXED_NOW,
  };
  return { deps, jira, store: deps.store };
}

function failedOf(issue: Parameters<typeof scoreIssue>[0]) {
  return scoreIssue(issue).checks.filter((check) => !check.passed);
}

describe('buildTemplateDraft', () => {
  it('produces the full section shape for an issue with real text', () => {
    const issue = makeIssue({ storyPoints: null });
    const sections = buildTemplateDraft(issue, failedOf(issue));
    expect(sections.map((section) => section.heading)).toEqual([
      'Goal',
      'Context',
      'Acceptance criteria',
      'Definition of done',
    ]);
    // The author's own text is preserved as context.
    expect(sections[1]?.paragraphs.join(' ')).toContain('token-bucket rate');
    // Criteria are derived from the issue's own sentences.
    expect(sections[2]?.paragraphs.join(' ')).toContain('HTTP 429');
  });

  it('omits Context when there is no meaningful existing text', () => {
    const issue = makeIssue({ summary: 'Fix bug', descriptionText: '' });
    const sections = buildTemplateDraft(issue, failedOf(issue));
    expect(sections.map((section) => section.heading)).toEqual([
      'Goal',
      'Acceptance criteria',
      'Definition of done',
    ]);
  });

  it('is deterministic — same issue, same draft', () => {
    const issue = makeIssue({ descriptionText: 'TBD. Something short.' });
    expect(buildTemplateDraft(issue, failedOf(issue))).toEqual(
      buildTemplateDraft(issue, failedOf(issue)),
    );
  });

  it('never emits the placeholder markers it exists to fix', () => {
    const issue = makeIssue({
      summary: 'Fix the TBD thing',
      descriptionText: 'TODO: write this. Details to be decided. Lorem ipsum.',
    });
    const text = extractTextFromAdf(buildAdfFromSections(buildTemplateDraft(issue, failedOf(issue))));
    expect(text).not.toMatch(/\b(tbd|tbc|todo|fixme|xxx)s?\b/i);
    expect(text.toLowerCase()).not.toContain('to be decided');
    expect(text.toLowerCase()).not.toContain('lorem ipsum');
    expect(text.toLowerCase()).not.toContain('placeholder text');
  });

  it('lifts a messy issue to exactly 60 when applied (hand-computed)', () => {
    // Messy fixture shape as a NormalizedIssue: only priority,
    // no-placeholders and the vacuous due-date pass (20 points).
    const messy = normalizeIssue(makeRawMessyIssue());
    expect(scoreIssue(messy).score).toBe(20);
    const sections = buildTemplateDraft(messy, failedOf(messy));
    const draftText = extractTextFromAdf(buildAdfFromSections(sections));
    expect(draftText.length).toBeGreaterThanOrEqual(280);
    const rescored = scoreIssue({ ...messy, descriptionText: draftText });
    // The draft fixes exactly the three description-owned checks:
    // description (20) + acceptance criteria (20) on top of the 20 the
    // issue already had. Fields the description cannot fix (estimate,
    // assignee, labels, links, summary) stay failing — honestly.
    expect(rescored.score).toBe(60);
    const byId = new Map(rescored.checks.map((check) => [check.id, check.passed]));
    expect(byId.get('description')).toBe(true);
    expect(byId.get('acceptance-criteria')).toBe(true);
    expect(byId.get('no-placeholders')).toBe(true);
    expect(byId.get('estimate')).toBe(false);
    expect(byId.get('assignee')).toBe(false);
  });

  it('uses the dedicated AC field as the criteria source when present', () => {
    const issue = makeIssue({
      descriptionText: 'Short.',
      acceptanceCriteriaText: 'First criterion from the field\nSecond criterion from the field',
    });
    const sections = buildTemplateDraft(issue, failedOf(issue));
    const ac = sections.find((section) => section.heading === 'Acceptance criteria');
    expect(ac?.paragraphs).toEqual([
      'First criterion from the field.',
      'Second criterion from the field.',
    ]);
  });

  it('keeps the full-description issue criteria from its own text', () => {
    const issue = makeIssue();
    const sections = buildTemplateDraft(issue, failedOf(issue));
    const ac = sections.find((section) => section.heading === 'Acceptance criteria');
    expect(ac?.paragraphs.join(' ')).toContain('Retry-After');
    expect(LONG_DESCRIPTION).toContain('Retry-After'); // fixture sanity
    // ...and those harvested lines are not repeated in Context.
    const context = sections.find((section) => section.heading === 'Context');
    expect(context?.paragraphs.join(' ')).not.toContain('HTTP 429');
    expect(context?.paragraphs.join(' ')).toContain('token-bucket rate');
  });
});

describe('improveIssue', () => {
  it('returns an LLM draft, parsed into sections, with a projected jump', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const result = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(result.source).toBe('llm');
    expect(result.fromCache).toBe(false);
    expect(result.currentScore).toBe(20);
    expect(result.projectedScore).toBeGreaterThan(20);
    expect(result.sections.map((section) => section.heading)).toEqual([
      'Goal',
      'Acceptance criteria',
    ]);
    expect(llm.calls).toHaveLength(1);
    // The LLM was told which checks fail.
    expect(llm.calls[0]?.failedChecks.map((check) => check.id)).toContain('description');
  });

  it('serves the second Improve from the content-hash cache', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const first = await improveIssue(deps, { issueKey: 'RS-3' });
    const second = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(second.fromCache).toBe(true);
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.sections).toEqual(first.sections);
    expect(llm.calls).toHaveLength(1);
  });

  it('misses the cache when the issue content changes', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const store = new ScoreStore(new InMemoryKV());
    const first = makeImproverDeps([makeRawMessyIssue()], llm, store);
    await improveIssue(first.deps, { issueKey: 'RS-3' });
    const changed = makeRawMessyIssue();
    changed.fields.description = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'A brand new short description that changed content.' }],
        },
      ],
    };
    const second = makeImproverDeps([changed], llm, store);
    const result = await improveIssue(second.deps, { issueKey: 'RS-3' });
    expect(result.fromCache).toBe(false);
    expect(llm.calls).toHaveLength(2);
  });

  it('falls back to the template when the LLM throws', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const result = await improveIssue(deps, { issueKey: 'RS-3' });
      expect(result.source).toBe('template');
      expect(result.sections.map((section) => section.heading)).toContain('Definition of done');
      expect(result.projectedScore).toBe(60);
    } finally {
      console.error = originalError;
    }
    // The fallback must never be silent: the failure is logged so a
    // live fallback can be diagnosed from the app logs (phase 2b).
    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain('LLM draft failed');
    expect(String(logged[0]?.[1])).toContain('LLM unavailable');
  });

  it('falls back to the template when the LLM reply is unusable', async () => {
    const llm = new FakeLlmClient(() => 'ok');
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const result = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(result.source).toBe('template');
  });
});

describe('applyImprovement', () => {
  it('writes the ADF, rescores, stores, and comments the real jump', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const { deps, jira, store } = makeImproverDeps([makeRawMessyIssue()], llm);
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: draft.contentHash,
    });
    expect(applied).toEqual({
      issueKey: 'RS-3',
      previousScore: 20,
      newScore: 60,
      source: 'template',
    });
    expect(jira.updateDescriptionCalls).toHaveLength(1);
    const writtenText = extractTextFromAdf(jira.updateDescriptionCalls[0]?.description);
    expect(writtenText).toContain('Acceptance criteria');
    expect(jira.addCommentCalls).toHaveLength(1);
    const commentText = extractTextFromAdf(jira.addCommentCalls[0]?.body);
    expect(commentText).toBe('Description improved with ReadySet — readiness 20 → 60.');
    // The stored score (dashboard + Coach source) is the new one.
    expect((await store.getScore('RS-3'))?.score).toBe(60);
  });

  it('applies an LLM draft end to end', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: draft.contentHash,
    });
    expect(applied.source).toBe('llm');
    expect(applied.newScore).toBe(draft.projectedScore);
    expect(jira.updateDescriptionCalls).toHaveLength(1);
  });

  it('refuses a stale draft after the issue changed', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    // Someone edits the issue between Improve and Apply (via the
    // adapter, exactly as a Jira edit would land).
    await jira.updateDescription('RS-3', {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Edited by a human after the draft was made.' }],
        },
      ],
    });
    const writesBefore = jira.updateDescriptionCalls.length;
    await expect(
      applyImprovement(deps, { issueKey: 'RS-3', contentHash: draft.contentHash }),
    ).rejects.toThrow(/changed since the draft/);
    expect(jira.updateDescriptionCalls).toHaveLength(writesBefore);
    expect(jira.addCommentCalls).toHaveLength(0);
  });

  it('refuses when no draft exists for the hash', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const issue = normalizeIssue(makeRawMessyIssue());
    const hash = improvementContentHash(issue, failedOf(issue));
    await expect(applyImprovement(deps, { issueKey: 'RS-3', contentHash: hash })).rejects.toThrow(
      /no longer available/,
    );
    expect(jira.updateDescriptionCalls).toHaveLength(0);
  });
});
