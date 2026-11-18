/**
 * Atlassian Document Format (ADF) helpers.
 *
 * `extractTextFromAdf` flattens a Jira description (ADF doc, legacy plain
 * string, or null) into plain text for the rubric. `buildAdfFromSections`
 * builds a valid ADF doc from structured sections — used by the Improve
 * flow when a rewritten description is applied (phase 2), and kept pure
 * so it is snapshot-testable now.
 */

export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: unknown[];
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'listItem',
  'codeBlock',
  'blockquote',
  'tableCell',
  'tableHeader',
  'panel',
  'expand',
  'taskItem',
  'decisionItem',
]);

function nodeText(node: AdfNode, parts: string[]): void {
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }
  if (node.type === 'hardBreak') {
    parts.push('\n');
  }
  if (node.type === 'mention' && typeof node.attrs?.text === 'string') {
    parts.push(node.attrs.text as string);
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      nodeText(child, parts);
    }
  }
  if (BLOCK_TYPES.has(node.type)) {
    parts.push('\n');
  }
}

/**
 * Flatten ADF (or a legacy string description) to plain text.
 * Block boundaries become newlines; runs of blank lines collapse.
 */
export function extractTextFromAdf(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (typeof input !== 'object') return '';
  const parts: string[] = [];
  nodeText(input as AdfNode, parts);
  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface DraftSection {
  heading: string;
  /** Paragraphs of body text; blank strings are dropped. */
  paragraphs: string[];
}

function paragraphNode(text: string): AdfNode {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function headingNode(text: string, level: number): AdfNode {
  return { type: 'heading', attrs: { level }, content: [{ type: 'text', text }] };
}

/**
 * Build an ADF doc from structured sections: each section becomes a
 * level-2 heading followed by its paragraphs. Deterministic output —
 * same input, same doc — so Apply never produces surprise formatting.
 */
export function buildAdfFromSections(sections: DraftSection[]): AdfDoc {
  const content: AdfNode[] = [];
  for (const section of sections) {
    const heading = section.heading.trim();
    const paragraphs = section.paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
    if (!heading && paragraphs.length === 0) continue;
    if (heading) content.push(headingNode(heading, 2));
    for (const paragraph of paragraphs) {
      content.push(paragraphNode(paragraph));
    }
  }
  if (content.length === 0) {
    content.push(paragraphNode(''));
  }
  return { type: 'doc', version: 1, content };
}
