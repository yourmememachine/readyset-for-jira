import { describe, expect, it } from 'vitest';
import {
  applyImprovement,
  applySummary,
  improvementContentHash,
  improveIssue,
  improveSummary,
  type ImproverDeps,
} from '../src/functions/improver';
import { buildAdfFromSections, extractTextFromAdf } from '../src/lib/adf';
import { buildTemplateDraft } from '../src/lib/improve-template';
import { FakeJiraAdapter, normalizeIssue, type RawJiraIssue } from '../src/lib/jira';
import type { DraftRequest, LlmClient } from '../src/lib/llm';
import { scoreIssue } from '../src/lib/rubric';
import { DEFAULT_IMPROVE_SECTIONS, DEFAULT_SETTINGS } from '../src/lib/rubric-config';
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
  '## Context',
  'The gateway currently lets any single integration consume the full request budget, and support tickets trace the worst latency spikes to exactly that pattern.',
  '',
  '## Acceptance criteria',
  '- Requests beyond the configured quota return HTTP 429 with a Retry-After header.',
  '- Quota is configurable per API key without a deploy.',
  '- Metrics expose rejected-request counts per API key.',
  '',
  '## Definition of done',
  'The limiter is live on the public gateway, the per-key metrics are visible on the operations dashboard, and the runbook documents how to raise a quota.',
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
      'Context',
      'Acceptance criteria',
      'Definition of done',
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

  it('falls back to the template when the LLM refuses a fact-free issue', async () => {
    // Live RS-9 (phase 2b): the model answered a fact-free issue with
    // a prose refusal instead of the section structure. The refusal
    // must never be offered — let alone applied — as a description.
    const llm = new FakeLlmClient(
      () =>
        'I cannot rewrite this issue because the current description is empty and contains no facts about what bug needs to be fixed, what system is affected, or how to verify it is resolved.\n\nTo proceed, I need you to provide:\nWhat is the bug? (What is broken or not working as expected?)',
    );
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const result = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(result.source).toBe('template');
    expect(result.projectedScore).toBe(60);
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
    expect(commentText).toBe(
      'Description improved with ReadySet — readiness 20 → 60.\n' +
        'Now passing: Description is substantial; Acceptance criteria present.',
    );
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
    const hash = improvementContentHash(issue, failedOf(issue), [...DEFAULT_IMPROVE_SECTIONS]);
    await expect(applyImprovement(deps, { issueKey: 'RS-3', contentHash: hash })).rejects.toThrow(
      /no longer available/,
    );
    expect(jira.updateDescriptionCalls).toHaveLength(0);
  });
});

describe('payload completeness (live RS-2 incident)', () => {
  // Improve drafts against the issue's failed checks and Apply
  // rescores from a re-read: a partial adapter payload would invent
  // phantom failures (and, on Apply, store a skeleton score), so
  // both entry points refuse incomplete payloads outright.
  class SparseGetIssue extends FakeJiraAdapter {
    override async getIssue(issueKey: string): Promise<RawJiraIssue> {
      return {
        key: issueKey,
        fields: {
          summary: 'Add rate limiting to the public API gateway endpoints',
          priority: { name: 'Medium' },
          status: { name: 'To Do', statusCategory: { key: 'new' } },
          project: { key: 'RS' },
          updated: '2026-11-17T20:21:00.000Z',
        },
      };
    }
  }

  function sparseDeps(llm: LlmClient) {
    const deps: ImproverDeps = {
      jira: new SparseGetIssue([]),
      store: new ScoreStore(new InMemoryKV()),
      llm,
      now: () => FIXED_NOW,
    };
    return deps;
  }

  it('improveIssue rejects a partial payload instead of drafting against phantom failures', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    await expect(improveIssue(sparseDeps(llm), { issueKey: 'RS-2' })).rejects.toThrow(
      /incomplete/i,
    );
    expect(llm.calls).toEqual([]);
  });

  it('applyImprovement rejects a partial payload before any write', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const deps = sparseDeps(llm);
    await expect(
      applyImprovement(deps, { issueKey: 'RS-2', contentHash: 'irrelevant' }),
    ).rejects.toThrow(/incomplete/i);
    expect((deps.jira as SparseGetIssue).updateDescriptionCalls).toEqual([]);
  });
});

describe('custom Improve structure (Wave 2)', () => {
  it('the template draft follows the configured section names and order', () => {
    const issue = makeIssue({ summary: 'Fix bug', descriptionText: '' });
    const sections = buildTemplateDraft(issue, [], ['Why', 'Acceptance criteria (done when)', 'Wrap-up']);
    expect(sections.map((section) => section.heading)).toEqual([
      'Why',
      'Acceptance criteria (done when)',
      'Wrap-up',
    ]);
  });

  it('normalizeImproveSections guarantees an acceptance-criteria heading', async () => {
    const { normalizeImproveSections } = await import('../src/lib/store');
    expect(normalizeImproveSections(['Goal', 'Notes'], ['Goal'])).toEqual([
      'Goal',
      'Acceptance criteria',
      'Notes',
    ]);
    expect(normalizeImproveSections([' goal ', 'GOAL', ''], ['Goal'])).toEqual([
      'Acceptance criteria',
      'goal',
    ]);
    expect(normalizeImproveSections([], ['Goal', 'Acceptance criteria'])).toEqual([
      'Goal',
      'Acceptance criteria',
    ]);
  });
});

describe('Apply permission gate + richer audit comment (Wave 2)', () => {
  it('refuses Apply when the user cannot edit issues, and writes nothing', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(payload.canApply).toBe(true);
    jira.editProjects = new Set<string>(); // user edits nothing
    const denied = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(denied.canApply).toBe(false);
    await expect(
      applyImprovement(deps, { issueKey: 'RS-3', contentHash: payload.contentHash }),
    ).rejects.toThrow(/do not have permission to edit issues/);
    expect(jira.updateDescriptionCalls).toHaveLength(0);
    expect(jira.addCommentCalls).toHaveLength(0);
  });

  it('the audit comment names the checks that flipped', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    await applyImprovement(deps, { issueKey: 'RS-3', contentHash: payload.contentHash });
    expect(jira.addCommentCalls).toHaveLength(1);
    const commentText = extractTextFromAdf(jira.addCommentCalls[0]?.body as never);
    expect(commentText).toContain('readiness 20 → 60');
    expect(commentText).toContain('Now passing:');
    expect(commentText).toContain('Description is substantial');
    expect(commentText).toContain('Acceptance criteria present');
  });
});

describe('AC-only Improve (Wave 3)', () => {
  const AC_MARKDOWN = [
    '## Acceptance criteria',
    '- Requests beyond quota return HTTP 429 with a Retry-After header.',
    '- Quota is configurable per API key without a deploy.',
  ].join('\n');

  function issueWithSections(key = 'RS-3'): RawJiraIssue {
    const raw = makeRawMessyIssue(key);
    raw.fields.summary = 'Gateway limiter';
    raw.fields.description = buildAdfFromSections([
      {
        heading: 'Goal',
        paragraphs: [
          'Add token-bucket rate limiting to the public API gateway so a single noisy integration cannot degrade latency for every other merchant using the platform, with per-key quotas and clear rejection signals.',
        ],
      },
      { heading: 'Notes', paragraphs: ['Roll out behind a feature flag first.'] },
    ]);
    return raw;
  }

  it('drafts a single AC section and projects the merged score', async () => {
    const llm = new FakeLlmClient(() => AC_MARKDOWN);
    const { deps } = makeImproverDeps([issueWithSections()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3', mode: 'ac-only' });
    expect(payload.mode).toBe('ac-only');
    expect(payload.source).toBe('llm');
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0]?.heading).toBe('Acceptance criteria');
    expect(payload.currentSections.map((section) => section.heading)).toEqual(['Goal', 'Notes']);
    // The existing description already passes description depth; adding
    // real criteria flips the AC check too.
    expect(payload.projectedScore).toBeGreaterThan(payload.currentScore);
    expect(llm.calls[0]?.mode).toBe('ac-only');
  });

  it('apply merges the AC section and leaves the other sections untouched', async () => {
    const llm = new FakeLlmClient(() => AC_MARKDOWN);
    const { deps, jira } = makeImproverDeps([issueWithSections()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3', mode: 'ac-only' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
    });
    expect(applied.newScore).toBe(payload.projectedScore);
    const written = extractTextFromAdf(jira.updateDescriptionCalls[0]?.description);
    expect(written).toContain('Add token-bucket rate limiting');
    expect(written).toContain('Roll out behind a feature flag first.');
    expect(written).toContain('Requests beyond quota return HTTP 429');
    const commentText = extractTextFromAdf(jira.addCommentCalls[0]?.body);
    expect(commentText).toContain('Acceptance criteria improved with ReadySet');
  });

  it('an AC-only draft and a full draft of the same issue do not collide', async () => {
    const llm = new FakeLlmClient((request) =>
      request.mode === 'ac-only' ? AC_MARKDOWN : GOOD_MARKDOWN,
    );
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const full = await improveIssue(deps, { issueKey: 'RS-3' });
    const acOnly = await improveIssue(deps, { issueKey: 'RS-3', mode: 'ac-only' });
    expect(full.contentHash).not.toBe(acOnly.contentHash);
    expect(full.sections.length).toBeGreaterThan(1);
    expect(acOnly.sections).toHaveLength(1);
  });

  it('selects the AC section by heading when the reply leads with another section (A1)', async () => {
    const STRAY_FIRST = [
      '## Goal',
      'Restate the goal the model was told not to write, in a paragraph long enough to parse as a real section of the draft reply.',
      '',
      '## Acceptance criteria',
      '- Requests beyond quota return HTTP 429 with a Retry-After header.',
    ].join('\n');
    const llm = new FakeLlmClient(() => STRAY_FIRST);
    const { deps, jira } = makeImproverDeps([issueWithSections()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3', mode: 'ac-only' });
    expect(payload.sections).toHaveLength(1);
    expect(payload.sections[0]?.heading).toBe('Acceptance criteria');
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
    });
    expect(applied.newScore).toBe(payload.projectedScore);
    const written = extractTextFromAdf(jira.updateDescriptionCalls[0]?.description);
    expect(written).toContain('Requests beyond quota return HTTP 429');
    expect(written).not.toContain('Restate the goal the model was told not to write');
    // The issue's own sections survive the merge.
    expect(written).toContain('Add token-bucket rate limiting');
    expect(written).toContain('Roll out behind a feature flag first.');
  });
});

describe('Improve & Assign (Wave 3)', () => {
  it('assigns to the current user after a successful apply when requested', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
      assignToMe: true,
      accountId: 'fake-current-user',
    });
    expect(applied.assigned).toBe(true);
    expect(jira.assignToUserCalls).toEqual([{ issueKey: 'RS-3', accountId: 'fake-current-user' }]);
    // Assignment happens before the rescore, so the reported score
    // includes the assignee check's 10 points (60 draft-only → 70).
    expect(applied.newScore).toBe(70);
  });

  it('an assignment failure is reported, never thrown over a successful apply', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    jira.assignError = new Error('no Assign permission');
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
      assignToMe: true,
      accountId: 'fake-current-user',
    });
    expect(applied.newScore).toBe(60);
    expect(applied.assigned).toBe(false);
    expect(applied.assignError).toContain('no Assign permission');
  });

  it('assign without an account id reports the miss and still applies (live-verification fix)', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN);
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
      assignToMe: true,
    });
    expect(applied.newScore).toBe(60);
    expect(applied.assigned).toBe(false);
    expect(applied.assignError).toMatch(/could not resolve the current user/);
    expect(jira.assignToUserCalls).toEqual([]);
  });
});

describe('Summary Improve (Wave 3)', () => {
  it('drafts and applies an LLM summary, rescoring the issue', async () => {
    const llm = new FakeLlmClient((request) =>
      request.kind === 'summary'
        ? 'Add token-bucket rate limiting to the public API gateway'
        : GOOD_MARKDOWN,
    );
    const { deps, jira } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveSummary(deps, { issueKey: 'RS-3' });
    expect(payload.source).toBe('llm');
    expect(payload.currentSummary).toBe('Fix bug');
    expect(payload.suggestedSummary).toBe('Add token-bucket rate limiting to the public API gateway');
    expect(payload.projectedScore).toBeGreaterThan(payload.currentScore);
    const applied = await applySummary(deps, {
      issueKey: 'RS-3',
      contentHash: payload.contentHash,
    });
    expect(jira.updateSummaryCalls).toEqual([
      { issueKey: 'RS-3', summary: 'Add token-bucket rate limiting to the public API gateway' },
    ]);
    expect(applied.newScore).toBe(payload.projectedScore);
    const commentText = extractTextFromAdf(jira.addCommentCalls[0]?.body);
    expect(commentText).toContain('Summary improved with ReadySet');
  });

  it('derives a summary from the description when the LLM is unavailable', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const raw = makeRawMessyIssue();
    raw.fields.description = buildAdfFromSections([
      {
        heading: 'Goal',
        paragraphs: [
          'Add token-bucket rate limiting to the public API gateway so noisy integrations cannot degrade latency for everyone else on the platform.',
        ],
      },
    ]);
    const { deps } = makeImproverDeps([raw], llm);
    const payload = await improveSummary(deps, { issueKey: 'RS-3' });
    expect(payload.source).toBe('template');
    expect(payload.suggestedSummary).toContain('Add token-bucket rate limiting');
  });

  it('refuses honestly when the issue has no text to derive a summary from', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    await expect(improveSummary(deps, { issueKey: 'RS-3' })).rejects.toThrow(/not enough text/);
  });

  it('derives from the first real section sentence — never glued headings, never mid-word (live find, 2026-11-18)', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const raw = makeRawMessyIssue();
    raw.fields.description = buildAdfFromSections([
      {
        heading: 'Acceptance criteria',
        paragraphs: [
          'The bug is identified and documented with steps to reproduce.',
          'A fix is implemented that resolves the reported issue.',
        ],
      },
    ]);
    const { deps } = makeImproverDeps([raw], llm);
    const payload = await improveSummary(deps, { issueKey: 'RS-3' });
    expect(payload.source).toBe('template');
    expect(payload.suggestedSummary).toBe(
      'The bug is identified and documented with steps to reproduce',
    );
  });

  it('truncates a long derivation on a word boundary', async () => {
    const llm = new FakeLlmClient(() => {
      throw new Error('LLM unavailable');
    });
    const raw = makeRawMessyIssue();
    const paragraph = 'Improve the gateway rate limiting behaviour for every merchant integration '
      .repeat(4)
      .trim();
    raw.fields.description = buildAdfFromSections([
      { heading: 'Goal', paragraphs: [paragraph] },
    ]);
    const { deps } = makeImproverDeps([raw], llm);
    const payload = await improveSummary(deps, { issueKey: 'RS-3' });
    const result = payload.suggestedSummary;
    expect(result.length).toBeLessThanOrEqual(200);
    // A true word boundary: the result is a prefix of the paragraph
    // and the paragraph continues with a space, not a letter.
    expect(paragraph.startsWith(result)).toBe(true);
    expect(paragraph.charAt(result.length)).toBe(' ');
  });

  it('a cached summary draft reports the LIVE current score, not the draft-time one (A6)', async () => {
    const llm = new FakeLlmClient((request) =>
      request.kind === 'summary'
        ? 'Add token-bucket rate limiting to the public API gateway'
        : GOOD_MARKDOWN,
    );
    const { deps, store } = makeImproverDeps([makeRawMessyIssue()], llm);
    const first = await improveSummary(deps, { issueKey: 'RS-3' });
    expect(first.currentScore).toBe(20);
    // A non-text change: turning the estimate check OFF renormalizes
    // the live score (20/90 → 22) without touching the summary hash,
    // so the second call serves the cached draft.
    await store.saveSettings('RS', {
      ...DEFAULT_SETTINGS,
      checksEnabled: { ...DEFAULT_SETTINGS.checksEnabled, estimate: false },
    });
    const second = await improveSummary(deps, { issueKey: 'RS-3' });
    expect(second.fromCache).toBe(true);
    expect(second.currentScore).toBe(22);
  });
});

describe('war-room fixes (2026-11-18)', () => {
  const throwingLlm = new FakeLlmClient(() => {
    throw new Error('LLM unavailable');
  });

  it('F9/C3: a bare Bug gets a reproduction-steps section built from its own text and can reach 60', async () => {
    const bug = makeRawMessyIssue('RS-7');
    bug.fields.issuetype = { name: 'Bug' };
    const { deps } = makeImproverDeps([bug], throwingLlm);
    const payload = await improveIssue(deps, { issueKey: 'RS-7' });
    expect(payload.source).toBe('template');
    expect(payload.currentScore).toBe(18);
    expect(payload.sections.map((section) => section.heading)).toContain('Steps to reproduce');
    expect(payload.projectedScore).toBeGreaterThanOrEqual(60);
  });

  it('F11: an LLM draft containing a placeholder is rejected and the template takes over', async () => {
    const llm = new FakeLlmClient(() => GOOD_MARKDOWN.replace('token-bucket', 'TBD'));
    const { deps } = makeImproverDeps([makeRawMessyIssue()], llm);
    const payload = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(payload.source).toBe('template');
    expect(payload.projectedScore).toBe(60);
  });

  it('B22: a successful Apply consumes the stored draft', async () => {
    const { deps, store } = makeImproverDeps([makeRawMessyIssue()], throwingLlm);
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    expect(await store.getDraft('RS-3', draft.contentHash)).toBeDefined();
    await applyImprovement(deps, { issueKey: 'RS-3', contentHash: draft.contentHash });
    expect(await store.getDraft('RS-3', draft.contentHash)).toBeUndefined();
  });

  it('B2: an ac-only Apply refuses a draft whose criteria section is gone instead of writing another section', async () => {
    const raw = makeRawMessyIssue('RS-3');
    raw.fields.summary = 'Gateway limiter';
    raw.fields.description = buildAdfFromSections([
      {
        heading: 'Goal',
        paragraphs: [
          'Add token-bucket rate limiting to the public API gateway so a single noisy integration cannot degrade latency for every other merchant using the platform, with per-key quotas and clear rejection signals.',
        ],
      },
      { heading: 'Notes', paragraphs: ['Roll out behind a feature flag first.'] },
    ]);
    const llm = new FakeLlmClient(() =>
      [
        '## Acceptance criteria',
        '- Requests beyond quota return HTTP 429 with a Retry-After header.',
        '- Quota is configurable per API key without a deploy.',
      ].join('\n'),
    );
    const { deps, jira, store } = makeImproverDeps([raw], llm);
    const draft = await improveIssue(deps, { issueKey: 'RS-3', mode: 'ac-only' });
    // Corrupt the stored draft: its only section is no longer the
    // criteria section. The old code fell back to sections[0] and
    // would have merged "Goal" in as the acceptance criteria.
    const stored = await store.getDraft('RS-3', draft.contentHash);
    if (!stored) throw new Error('draft missing');
    await store.saveDraft({
      ...stored,
      sections: [{ heading: 'Goal', paragraphs: ['Overwrite the goal with this text.'] }],
    });
    await expect(
      applyImprovement(deps, { issueKey: 'RS-3', contentHash: draft.contentHash }),
    ).rejects.toThrow(/no longer available/);
    expect(jira.updateDescriptionCalls).toHaveLength(0);
  });

  it('F7/B1: a post-write re-read failure returns success with a warning, never a retryable error', async () => {
    class PostWriteFailJira extends FakeJiraAdapter {
      private reads = 0;
      override async getIssue(issueKey: string) {
        this.reads += 1;
        if (this.reads >= 3) throw new Error('read-back failed');
        return super.getIssue(issueKey);
      }
    }
    const jira = new PostWriteFailJira([makeRawMessyIssue()]);
    const store = new ScoreStore(new InMemoryKV());
    const deps: ImproverDeps = { jira, store, llm: throwingLlm, now: () => FIXED_NOW };
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: draft.contentHash,
    });
    // The write landed exactly once; the score is reported as the
    // pre-Apply score (unconfirmed) with an honest warning attached.
    expect(jira.updateDescriptionCalls).toHaveLength(1);
    expect(applied.previousScore).toBe(20);
    expect(applied.newScore).toBe(20);
    expect(applied.postWriteWarning).toMatch(/could not re-read/);
    expect(await store.getDraft('RS-3', draft.contentHash)).toBeUndefined();
  });

  it('F7/B1: a failed audit comment returns the real new score with a warning', async () => {
    class CommentFailJira extends FakeJiraAdapter {
      override async addComment(): Promise<void> {
        throw new Error('comment failed');
      }
    }
    const jira = new CommentFailJira([makeRawMessyIssue()]);
    const store = new ScoreStore(new InMemoryKV());
    const deps: ImproverDeps = { jira, store, llm: throwingLlm, now: () => FIXED_NOW };
    const draft = await improveIssue(deps, { issueKey: 'RS-3' });
    const applied = await applyImprovement(deps, {
      issueKey: 'RS-3',
      contentHash: draft.contentHash,
    });
    expect(applied.newScore).toBe(60);
    expect(applied.postWriteWarning).toMatch(/audit comment/);
  });

  it('F7/B1: the summary Apply path guards its post-write steps the same way', async () => {
    class CommentFailJira extends FakeJiraAdapter {
      override async addComment(): Promise<void> {
        throw new Error('comment failed');
      }
    }
    const jira = new CommentFailJira([makeRawMessyIssue()]);
    const store = new ScoreStore(new InMemoryKV());
    const llm = new FakeLlmClient((request) =>
      request.kind === 'summary'
        ? 'Add token-bucket rate limiting to the public API gateway'
        : GOOD_MARKDOWN,
    );
    const deps: ImproverDeps = { jira, store, llm, now: () => FIXED_NOW };
    const draft = await improveSummary(deps, { issueKey: 'RS-3' });
    const applied = await applySummary(deps, { issueKey: 'RS-3', contentHash: draft.contentHash });
    expect(jira.updateSummaryCalls).toHaveLength(1);
    expect(applied.postWriteWarning).toMatch(/audit comment/);
    expect(await store.getSummaryDraft('RS-3', draft.contentHash)).toBeUndefined();
  });
});
