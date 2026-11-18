import { describe, expect, it } from 'vitest';
import { buildAdfFromSections, extractTextFromAdf } from '../src/lib/adf';

describe('extractTextFromAdf', () => {
  it('returns empty string for null/undefined', () => {
    expect(extractTextFromAdf(null)).toBe('');
    expect(extractTextFromAdf(undefined)).toBe('');
  });

  it('passes plain strings through (legacy descriptions)', () => {
    expect(extractTextFromAdf('plain text description')).toBe('plain text description');
  });

  it('flattens paragraphs, headings and lists with newlines between blocks', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Context' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'First paragraph.' }] },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item two' }] }] },
          ],
        },
      ],
    };
    const text = extractTextFromAdf(doc);
    expect(text).toContain('Context');
    expect(text).toContain('First paragraph.');
    expect(text).toContain('Item one');
    expect(text).toContain('Item two');
    expect(text.indexOf('Context')).toBeLessThan(text.indexOf('First paragraph.'));
  });

  it('includes mention text and code block content', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { id: '123', text: '@Ada' } },
            { type: 'text', text: ' to review' },
          ],
        },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm test' }] },
      ],
    };
    const text = extractTextFromAdf(doc);
    expect(text).toContain('Ask @Ada to review');
    expect(text).toContain('npm test');
  });

  it('A20: reads text carried in attrs (emoji, status, date, expand title, cards)', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'expand',
          attrs: { title: 'Acceptance criteria' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Returns 429 on breach.' }] },
          ],
        },
        {
          type: 'paragraph',
          content: [
            { type: 'emoji', attrs: { shortName: ':rocket:', text: '🚀' } },
            { type: 'status', attrs: { text: 'IN REVIEW' } },
            { type: 'date', attrs: { timestamp: '1798761600000' } },
            { type: 'inlineCard', attrs: { url: 'https://example.com/spec' } },
          ],
        },
      ],
    };
    const text = extractTextFromAdf(doc);
    expect(text).toContain('Acceptance criteria');
    expect(text).toContain('Returns 429 on breach.');
    expect(text).toContain('🚀');
    expect(text).toContain('IN REVIEW');
    expect(text).toContain('1798761600000');
    expect(text).toContain('https://example.com/spec');
    // The expand title lands on its own line so the rubric's AC heading
    // detection can see it.
    expect(text.split('\n')[0]).toBe('Acceptance criteria');
  });

  it('collapses runs of blank lines', () => {
    const doc = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Two' }] },
      ],
    };
    expect(extractTextFromAdf(doc)).not.toContain('\n\n\n');
  });
});

describe('buildAdfFromSections', () => {
  it('builds a valid doc with level-2 headings and paragraphs', () => {
    const doc = buildAdfFromSections([
      { heading: 'Goal', paragraphs: ['Ship the limiter.'] },
      { heading: 'Acceptance criteria', paragraphs: ['429 on quota breach.', 'Metrics per key.'] },
    ]);
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    expect(doc.content).toHaveLength(5);
    expect(doc.content[0]).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Goal' }],
    });
    expect(doc.content[1]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'Ship the limiter.' }],
    });
  });

  it('round-trips: text extracted from a built doc contains every section', () => {
    const doc = buildAdfFromSections([
      { heading: 'Context', paragraphs: ['Traffic is bursty.'] },
      { heading: 'Acceptance criteria', paragraphs: ['Quota returns 429.'] },
    ]);
    const text = extractTextFromAdf(doc);
    expect(text).toContain('Context');
    expect(text).toContain('Traffic is bursty.');
    expect(text).toContain('Acceptance criteria');
    expect(text).toContain('Quota returns 429.');
  });

  it('drops blank paragraphs and empty sections, never returns an empty doc', () => {
    const doc = buildAdfFromSections([{ heading: '', paragraphs: ['', '  '] }]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]?.type).toBe('paragraph');
  });

  it('A16: the empty fallback is a contentless paragraph — no empty text node', () => {
    const doc = buildAdfFromSections([]);
    expect(doc.content).toHaveLength(1);
    expect(doc.content[0]).toEqual({ type: 'paragraph' });
  });

  it('A16: no node in any built doc is an empty text node (ADF validity)', () => {
    const docs = [
      buildAdfFromSections([]),
      buildAdfFromSections([{ heading: 'Goal', paragraphs: ['Ship it.'] }]),
      buildAdfFromSections([{ heading: '', paragraphs: ['', '  '] }]),
    ];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      const candidate = node as { type?: string; text?: unknown; content?: unknown[] };
      if (candidate.type === 'text') {
        expect(typeof candidate.text).toBe('string');
        expect((candidate.text as string).length).toBeGreaterThan(0);
      }
      for (const child of candidate.content ?? []) walk(child);
    };
    for (const doc of docs) walk(doc);
  });

  it('is deterministic', () => {
    const sections = [{ heading: 'Goal', paragraphs: ['One.', 'Two.'] }];
    expect(buildAdfFromSections(sections)).toEqual(buildAdfFromSections(sections));
  });
});
