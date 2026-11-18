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

  it('is deterministic', () => {
    const sections = [{ heading: 'Goal', paragraphs: ['One.', 'Two.'] }];
    expect(buildAdfFromSections(sections)).toEqual(buildAdfFromSections(sections));
  });
});
