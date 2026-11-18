import { describe, expect, it } from 'vitest';
import { buildDraftPrompt, parseDraftMarkdown, parseSummaryReply } from '../src/lib/llm';
import { scoreIssue } from '../src/lib/rubric';
import { makeIssue } from './fixtures';

describe('parseDraftMarkdown', () => {
  it('splits a contract-shaped reply into sections', () => {
    const sections = parseDraftMarkdown(
      [
        '## Goal',
        'Add token-bucket rate limiting to the public API gateway so noisy integrations cannot degrade latency for everyone.',
        '',
        '## Context',
        'One integration can currently consume the whole request budget.',
        '',
        '## Acceptance criteria',
        '- Requests beyond quota return HTTP 429 with a Retry-After header.',
        '- Quota is configurable per API key without a deploy.',
        '',
        '## Definition of done',
        'The limiter is live and the runbook documents quota changes.',
      ].join('\n'),
    );
    expect(sections.map((section) => section.heading)).toEqual([
      'Goal',
      'Context',
      'Acceptance criteria',
      'Definition of done',
    ]);
    expect(sections[0]?.paragraphs).toHaveLength(1);
    // Bullets become their own paragraphs, markers stripped.
    expect(sections[2]?.paragraphs).toEqual([
      'Requests beyond quota return HTTP 429 with a Retry-After header.',
      'Quota is configurable per API key without a deploy.',
    ]);
  });

  it('keeps a preamble as an unheaded section instead of dropping it', () => {
    const sections = parseDraftMarkdown(
      [
        'This preamble explains the change in enough detail to be usable content.',
        '',
        '## Goal',
        'Ship it safely.',
        '',
        '## Context',
        'Shipping safely matters here.',
        '',
        '## Acceptance criteria',
        '- The change is verified in production.',
        '',
        '## Definition of done',
        'Verified in production and announced to the team.',
      ].join('\n'),
    );
    expect(sections[0]?.heading).toBe('');
    expect(sections[0]?.paragraphs[0]).toContain('preamble');
    expect(sections[1]?.heading).toBe('Goal');
    expect(sections[3]?.heading).toBe('Acceptance criteria');
  });

  it('throws when a configured section is missing from the reply (A6)', () => {
    const missingContext = [
      '## Goal',
      'Ship the thing with enough surrounding detail to be a usable draft body.',
      '',
      '## Acceptance criteria',
      '- The change is verified in production.',
      '',
      '## Definition of done',
      'Verified in production and announced to the team.',
    ].join('\n');
    expect(() => parseDraftMarkdown(missingContext)).toThrow(/missing configured section/);
  });

  it('throws on a refusal-style reply that ignores the section contract', () => {
    // The live RS-9 failure: the model declined to rewrite a fact-free
    // issue in plain prose. Length alone would have accepted it.
    const refusal = [
      'I cannot rewrite this issue because the current description is empty and contains no facts about what bug needs to be fixed, what system is affected, or how to verify it is resolved.',
      '',
      'To proceed, I need you to provide:',
      'What is the bug? (What is broken or not working as expected?)',
    ].join('\n');
    expect(() => parseDraftMarkdown(refusal)).toThrow(/section contract/);
  });

  it('throws when the reply has sections but no Acceptance criteria', () => {
    const noCriteria = '## Goal\nShip it safely and verify the behaviour end to end in production.';
    expect(() => parseDraftMarkdown(noCriteria)).toThrow(/section contract/);
  });

  it('throws on a reply with no usable content', () => {
    expect(() => parseDraftMarkdown('ok')).toThrow(/no usable content/);
    expect(() => parseDraftMarkdown('## Goal\n')).toThrow(/no usable content/);
    expect(() => parseDraftMarkdown('')).toThrow(/no usable content/);
  });
});

describe('buildDraftPrompt', () => {
  it('carries the issue, the failed checks, and the section contract', () => {
    const issue = makeIssue({ summary: 'Fix bug', descriptionText: '', storyPoints: null });
    const failed = scoreIssue(issue).checks.filter((check) => !check.passed);
    const prompt = buildDraftPrompt({ issue, failedChecks: failed });
    expect(prompt.system).toContain('## Acceptance criteria');
    expect(prompt.system).toContain('Never invent');
    expect(prompt.system).toContain('Never refuse');
    expect(prompt.user).toContain('RS-1');
    expect(prompt.user).toContain('Fix bug');
    expect(prompt.user).toContain('Current description:');
    expect(prompt.user).toContain('(empty)');
    // The estimate failure's fix hint is handed to the model verbatim.
    expect(prompt.user).toContain('Estimate the work');
  });

  it('ac-only mode asks for exactly one section (Wave 3)', () => {
    const issue = makeIssue({ summary: 'Fix bug', descriptionText: '', storyPoints: null });
    const failed = scoreIssue(issue).checks.filter((check) => !check.passed);
    const prompt = buildDraftPrompt({ issue, failedChecks: failed, mode: 'ac-only' });
    expect(prompt.system).toContain('exactly one level-2 heading: ## Acceptance criteria');
    expect(prompt.system).toContain('Never refuse');
    expect(prompt.system).not.toContain('## Goal');
  });

  it('summary kind asks for one line under 120 characters (Wave 3)', () => {
    const issue = makeIssue({ summary: 'Fix bug', descriptionText: 'Something real.' });
    const prompt = buildDraftPrompt({ issue, failedChecks: [], kind: 'summary' });
    expect(prompt.system).toContain('ONE summary line only');
    expect(prompt.system).toContain('under 120 characters');
    expect(prompt.user).toContain('Current summary: Fix bug');
  });
});

describe('parseSummaryReply (Wave 3)', () => {
  it('accepts a clean one-line summary and strips dressing', () => {
    expect(parseSummaryReply('Add token-bucket rate limiting to the API gateway')).toBe(
      'Add token-bucket rate limiting to the API gateway',
    );
    expect(parseSummaryReply('"Add rate limiting to the API gateway"')).toBe(
      'Add rate limiting to the API gateway',
    );
  });

  it('throws on placeholders, empties, and over-long replies', () => {
    expect(() => parseSummaryReply('TBD — fix the gateway thing')).toThrow(/placeholder/);
    expect(() => parseSummaryReply('')).toThrow(/empty/);
    expect(() => parseSummaryReply('short')).toThrow(/not a usable/);
    expect(() => parseSummaryReply('x'.repeat(300))).toThrow(/not a usable/);
  });
});
