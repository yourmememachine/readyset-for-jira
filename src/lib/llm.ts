/**
 * LLM drafting boundary for the Improve flow (phase 2a).
 *
 * Everything in this file is pure: the {@link LlmClient} interface, the
 * prompt construction, and the parser that turns the model's markdown
 * reply into structured draft sections. The production binding to
 * `@forge/llm` lives in `forge-llm.ts` — the ONLY file that imports
 * it — and tests substitute a fake client, so no test ever makes a
 * real LLM call (DESIGN.md §5.1: the LLM never blocks the core; on any
 * failure the caller falls back to the deterministic template).
 */
import type { DraftSection } from './adf';
import type { CheckResult, NormalizedIssue } from './types';

export interface DraftRequest {
  issue: NormalizedIssue;
  /** The rubric checks the issue currently fails — the draft's targets. */
  failedChecks: CheckResult[];
}

/**
 * A source of improvement drafts. Implementations return markdown
 * following the section contract in {@link buildDraftPrompt}; the
 * improver parses it with {@link parseDraftMarkdown}. Implementations
 * MUST throw on failure (transport, quota, empty reply) — the caller
 * owns the fallback decision.
 */
export interface LlmClient {
  draftDescription(request: DraftRequest): Promise<string>;
}

/** The section headings the draft contract is built around. */
export const DRAFT_HEADINGS = ['Goal', 'Context', 'Acceptance criteria', 'Notes'] as const;

export function buildDraftPrompt(request: DraftRequest): { system: string; user: string } {
  const { issue, failedChecks } = request;
  const system = [
    'You rewrite Jira issue descriptions for a sprint-readiness tool.',
    'Reply with markdown using exactly these level-2 headings, in this order:',
    ...DRAFT_HEADINGS.map((heading) => `## ${heading}`),
    'Rules:',
    '- Use ONLY facts present in the issue text you are given. Never invent names, dates, metrics, systems, or requirements.',
    '- Acceptance criteria must be testable statements, one per line, each starting with "- ".',
    '- Never write TBD, TODO, or any placeholder marker.',
    '- Keep the whole reply under 600 tokens. Plain paragraphs, no code fences.',
  ].join('\n');
  const lines = [
    `Issue: ${issue.key} — ${issue.summary}`,
    '',
    'Current description:',
    issue.descriptionText.trim().length > 0 ? issue.descriptionText : '(empty)',
  ];
  if (issue.acceptanceCriteriaText && issue.acceptanceCriteriaText.trim().length > 0) {
    lines.push('', 'Dedicated acceptance-criteria field:', issue.acceptanceCriteriaText);
  }
  if (failedChecks.length > 0) {
    lines.push(
      '',
      'Readiness checks this issue fails (the rewrite should address the description-related ones):',
      ...failedChecks.map((check) => `- ${check.label}: ${check.fixHint}`),
    );
  }
  return { system, user: lines.join('\n') };
}

/**
 * Parse a model reply into draft sections. Splits on `## ` headings;
 * bullet lines become their own paragraphs (the ADF builder renders
 * paragraphs — list fidelity is a presentation detail, content is
 * what the rubric scores). Throws when the reply carries no usable
 * content, so the caller falls back to the template instead of
 * offering an empty or garbage draft.
 */
export function parseDraftMarkdown(markdown: string): DraftSection[] {
  const sections: DraftSection[] = [];
  let current: DraftSection | null = null;
  const pushParagraphs = (section: DraftSection, bodyLines: string[]): void => {
    let buffer: string[] = [];
    const flush = (): void => {
      const text = buffer.join(' ').trim();
      if (text.length > 0) section.paragraphs.push(text);
      buffer = [];
    };
    for (const rawLine of bodyLines) {
      const line = rawLine.trim();
      if (line.length === 0) {
        flush();
      } else if (/^[-*]\s+/.test(line)) {
        flush();
        section.paragraphs.push(line.replace(/^[-*]\s+/, ''));
      } else {
        buffer.push(line);
      }
    }
    flush();
  };

  let body: string[] = [];
  const flushSection = (): void => {
    if (current) {
      pushParagraphs(current, body);
      if (current.paragraphs.length > 0) sections.push(current);
    }
    body = [];
  };
  for (const line of markdown.split('\n')) {
    const headingMatch = line.match(/^##\s+(.+?)\s*$/);
    if (headingMatch) {
      flushSection();
      current = { heading: headingMatch[1] ?? '', paragraphs: [] };
    } else if (current) {
      body.push(line);
    } else if (line.trim().length > 0) {
      // Preamble before the first heading: keep it as an unheaded
      // section rather than silently dropping model content.
      current = { heading: '', paragraphs: [] };
      body.push(line);
    }
  }
  flushSection();

  const totalChars = sections.reduce(
    (sum, section) =>
      sum + section.paragraphs.reduce((inner, paragraph) => inner + paragraph.length, 0),
    0,
  );
  if (sections.length === 0 || totalChars < 40) {
    throw new Error('ReadySet: LLM draft reply had no usable content');
  }
  return sections;
}
