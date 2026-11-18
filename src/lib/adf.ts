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

/**
 * Node types whose human-readable text lives in `attrs`, not in child
 * text nodes (cross-review A20). Dropping them undercounts real
 * descriptions — including "Acceptance criteria" expand titles.
 */
const ATTRS_TEXT: Record<string, (attrs: Record<string, unknown>) => string | null> = {
  mention: (attrs) => (typeof attrs.text === 'string' ? attrs.text : null),
  emoji: (attrs) =>
    typeof attrs.text === 'string'
      ? attrs.text
      : typeof attrs.shortName === 'string'
        ? attrs.shortName
        : null,
  status: (attrs) => (typeof attrs.text === 'string' ? attrs.text : null),
  date: (attrs) =>
    typeof attrs.timestamp === 'string' || typeof attrs.timestamp === 'number'
      ? String(attrs.timestamp)
      : null,
  expand: (attrs) => (typeof attrs.title === 'string' ? attrs.title : null),
  nestedExpand: (attrs) => (typeof attrs.title === 'string' ? attrs.title : null),
  inlineCard: (attrs) => (typeof attrs.url === 'string' ? attrs.url : null),
  blockCard: (attrs) => (typeof attrs.url === 'string' ? attrs.url : null),
};

function nodeText(node: AdfNode, parts: string[]): void {
  if (typeof node.text === 'string') {
    parts.push(node.text);
  }
  if (node.type === 'hardBreak') {
    parts.push('\n');
  }
  const attrsText = ATTRS_TEXT[node.type];
  if (attrsText && node.attrs) {
    const text = attrsText(node.attrs);
    if (text) {
      parts.push(text);
      // An expand title is a heading: it must end its own line, or it
      // glues onto the first body word and line-anchored consumers
      // (the rubric's AC-section detection) can never see it.
      if (node.type === 'expand' || node.type === 'nestedExpand') parts.push('\n');
    }
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

/** Anchored AC heading test — the same rule the rubric applies. */
const AC_HEADING_TEXT_RE = /^acceptance criteria\b/i;

function nodePlainText(node: AdfNode): string {
  const parts: string[] = [];
  nodeText(node, parts);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Split a description doc into sections at its top-level headings
 * (Wave 3 diff view + partial Improve). Content before the first
 * heading becomes an unheaded section; non-paragraph blocks flatten
 * to their text as paragraphs. Lossy by design — this is a reading
 * view, never a write path.
 */
export function sectionsFromAdf(input: unknown): DraftSection[] {
  if (input === null || input === undefined) return [];
  if (typeof input === 'string') {
    return input.trim().length > 0 ? [{ heading: '', paragraphs: [input.trim()] }] : [];
  }
  if (typeof input !== 'object') return [];
  const doc = input as AdfDoc;
  if (!Array.isArray(doc.content)) return [];
  const sections: DraftSection[] = [];
  let current: DraftSection = { heading: '', paragraphs: [] };
  const flush = (): void => {
    if (current.heading.length > 0 || current.paragraphs.length > 0) sections.push(current);
  };
  for (const node of doc.content) {
    if (node.type === 'heading') {
      flush();
      current = { heading: nodePlainText(node), paragraphs: [] };
    } else {
      const text = nodePlainText(node);
      if (text.length > 0) current.paragraphs.push(text);
    }
  }
  flush();
  return sections;
}

/**
 * Replace (or append) the Acceptance criteria section of an existing
 * description doc, leaving every other section untouched (Wave 3
 * partial Improve). Works on top-level ADF nodes: the AC section is
 * the run of non-heading nodes after an anchored AC heading. A doc
 * with no AC heading gains one at the end; an empty doc becomes just
 * the AC section.
 */
export function mergeAcSectionIntoAdf(input: unknown, acSection: DraftSection): AdfDoc {
  const replacement: AdfNode[] = [
    headingNode(acSection.heading, 2),
    ...acSection.paragraphs.map((paragraph) => paragraphNode(paragraph)),
  ];
  if (typeof input === 'string') {
    // Legacy plain-string description (cross-review A4): the text is a
    // real unheaded section, not nothing — keep it and append the AC
    // section after it instead of destroying the original content.
    const text = input.trim();
    if (text.length === 0) return { type: 'doc', version: 1, content: replacement };
    return { type: 'doc', version: 1, content: [paragraphNode(text), ...replacement] };
  }
  if (input === null || input === undefined || typeof input !== 'object') {
    return { type: 'doc', version: 1, content: replacement };
  }
  const doc = input as AdfDoc;
  if (!Array.isArray(doc.content) || doc.content.length === 0) {
    return { type: 'doc', version: 1, content: replacement };
  }
  const content: AdfNode[] = [];
  let replaced = false;
  let skipping = false;
  for (const node of doc.content) {
    if (node.type === 'heading') {
      if (!replaced && AC_HEADING_TEXT_RE.test(nodePlainText(node))) {
        content.push(...replacement);
        replaced = true;
        skipping = true;
        continue;
      }
      skipping = false;
      content.push(node);
      continue;
    }
    if (!skipping) content.push(node);
  }
  if (!replaced) content.push(...replacement);
  return { type: 'doc', version: 1, content };
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
    // ADF text nodes must not be empty ("text must not be empty" —
    // Atlassian Document Format spec), so the empty fallback is a
    // paragraph with no content at all (cross-review A16).
    content.push({ type: 'paragraph' });
  }
  return { type: 'doc', version: 1, content };
}
