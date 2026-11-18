import { describe, expect, it } from 'vitest';
import { buildDraftPrompt, parseDraftMarkdown } from '../src/lib/llm';
import { scoreIssue } from '../src/lib/rubric';
import { makeIssue } from './fixtures';

describe('parseDraftMarkdown', () => {
  it('splits a contract-shaped reply into sections', () => {
    const sections = parseDraftMarkdown(
      [
        '## Goal',
        'Add token-bucket rate limiting to the public API gateway so noisy integrations cannot degrade latency for everyone.',
        '',
        '## Acceptance criteria',
        '- Requests beyond quota return HTTP 429 with a Retry-After header.',
        '- Quota is configurable per API key without a deploy.',
      ].join('\n'),
    );
    expect(sections.map((section) => section.heading)).toEqual(['Goal', 'Acceptance criteria']);
    expect(sections[0]?.paragraphs).toHaveLength(1);
    // Bullets become their own paragraphs, markers stripped.
    expect(sections[1]?.paragraphs).toEqual([
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
        '## Acceptance criteria',
        '- The change is verified in production.',
      ].join('\n'),
    );
    expect(sections[0]?.heading).toBe('');
    expect(sections[0]?.paragraphs[0]).toContain('preamble');
    expect(sections[1]?.heading).toBe('Goal');
    expect(sections[2]?.heading).toBe('Acceptance criteria');
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
    expect(prompt.user).toContain('(empty)');
    // The estimate failure's fix hint is handed to the model verbatim.
    expect(prompt.user).toContain('Estimate the work');
  });
});
