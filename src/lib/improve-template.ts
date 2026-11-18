/**
 * Deterministic template fallback for Improve (phase 2a).
 *
 * When the Forge LLM is unavailable, errors, or returns unusable
 * output, Improve still offers a draft — built here from the issue's
 * own text by fixed rules. No randomness, no clock, no I/O: the same
 * issue always yields the same draft, which is what makes the
 * fallback testable and the demo reproducible (DESIGN.md §5.1).
 *
 * The template only rearranges and completes what is already on the
 * issue: the summary becomes the goal statement, meaningful existing
 * description text is preserved as context, acceptance criteria are
 * derived from the issue's own sentences (or its dedicated AC field),
 * and the definition of done names the verification steps. It never
 * invents facts — and it is careful to never emit the placeholder
 * markers the rubric scans for (a draft containing "TBD" would fail
 * the very check it exists to fix).
 */
import type { DraftSection } from './adf';
import { DEFAULT_IMPROVE_SECTIONS, PLACEHOLDER_PHRASES, PLACEHOLDER_TOKENS } from './rubric-config';
import { acceptanceCriteriaSectionBody } from './rubric';
import type { CheckResult, NormalizedIssue } from './types';

const MARKER_TOKEN_RE = new RegExp(`\\b(?:${PLACEHOLDER_TOKENS.join('|')})s?\\b`, 'gi');

/**
 * Remove placeholder markers from a line of issue text. Lines that
 * were nothing but markers disappear entirely; surviving text keeps
 * its meaning.
 */
function cleanLine(line: string): string {
  let cleaned = line.replace(MARKER_TOKEN_RE, ' ');
  for (const phrase of PLACEHOLDER_PHRASES) {
    cleaned = cleaned.replace(new RegExp(phrase, 'gi'), ' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function cleanLines(text: string): string[] {
  return text
    .split('\n')
    .map(cleanLine)
    .filter((line) => line.length > 0);
}

/** Text worth preserving: at least a short sentence of real content. */
function isMeaningful(text: string): boolean {
  return text.replace(/[^a-z0-9]+/gi, '').length >= 20;
}

function ensureSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Split cleaned text into candidate criterion sentences. */
function sentencesOf(text: string): string[] {
  const sentences: string[] = [];
  // Join wrapped lines first: issue text is hard-wrapped mid-sentence
  // as often as not, and per-line splitting would harvest fragments.
  for (const part of text.replace(/\n/g, ' ').split(/(?<=[.!?])\s+/)) {
    const sentence = part.trim();
    if (sentence.length >= 25 && !sentences.includes(sentence)) {
      sentences.push(sentence);
    }
  }
  return sentences;
}

function buildGoal(issue: NormalizedIssue, contextLines: string[], heading: string): DraftSection {
  const paragraphs: string[] = [];
  const summary = cleanLine(issue.summary);
  if (isMeaningful(summary)) {
    paragraphs.push(ensureSentence(summary));
  } else if (contextLines.length > 0) {
    const first = sentencesOf(contextLines.join('\n'))[0];
    if (first) paragraphs.push(ensureSentence(first));
  }
  paragraphs.push(
    'This work is complete when every acceptance criterion below is verified ' +
      'and the definition of done at the end of this description is satisfied.',
  );
  return { heading, paragraphs };
}

function buildContext(contextLines: string[], heading: string): DraftSection | null {
  if (contextLines.length === 0) return null;
  // Preserve the author's own words (markers stripped), grouped back
  // into at most three paragraphs so the draft stays readable.
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  for (const line of contextLines) {
    buffer.push(line);
    if (buffer.join(' ').length >= 240 && paragraphs.length < 2) {
      paragraphs.push(buffer.join(' '));
      buffer = [];
    }
  }
  if (buffer.length > 0) paragraphs.push(buffer.join(' '));
  return { heading, paragraphs };
}

function buildAcceptanceCriteria(
  issue: NormalizedIssue,
  contextLines: string[],
  heading: string,
): DraftSection {
  let criteria: string[] = [];
  const fieldText = issue.acceptanceCriteriaText ?? '';
  if (fieldText.trim().length > 0) {
    criteria = cleanLines(fieldText).map((line) => line.replace(/^[-*•]\s*/, ''));
  }
  if (criteria.length === 0) {
    // The author already wrote an AC section: harvest its lines
    // verbatim (markers stripped) before falling back to prose
    // sentences — their criteria outrank our extraction.
    const sectionBody = acceptanceCriteriaSectionBody(issue.descriptionText);
    if (sectionBody) {
      criteria = cleanLines(sectionBody)
        .map((line) => line.replace(/^[-*•]\s*/, ''))
        .filter((line) => line.length >= 15);
    }
  }
  if (criteria.length === 0) {
    criteria = sentencesOf(contextLines.join('\n'));
  }
  if (criteria.length === 0) {
    const summary = cleanLine(issue.summary);
    criteria = [
      summary.length > 0
        ? `The work described in the summary — "${summary}" — is implemented, and its behavior is demonstrable.`
        : 'The behavior described in this issue is implemented, and its behavior is demonstrable.',
    ];
  }
  return {
    heading,
    paragraphs: criteria.slice(0, 5).map(ensureSentence),
  };
}

function buildDefinitionOfDone(failedChecks: CheckResult[], heading: string): DraftSection {
  const failed = new Set(failedChecks.map((check) => check.id));
  const paragraphs = [
    "The change is reviewed and merged following the team's review process.",
    'Each acceptance criterion above is verified one by one, and the verification is recorded on this issue.',
  ];
  if (failed.has('estimate')) {
    paragraphs.push('The work is estimated (story points or time), and the estimate is recorded on this issue.');
  }
  if (failed.has('no-placeholders')) {
    paragraphs.push('No unresolved markers remain anywhere in the summary or description.');
  }
  return { heading, paragraphs };
}

/**
 * Build the fallback draft for an issue from its failed checks.
 * Pure and deterministic — the improver calls this when the LLM path
 * throws, and tests pin its exact shape.
 *
 * Wave 2: the section structure comes from project settings. Content
 * blocks map onto the requested headings by name (goal / context /
 * acceptance criteria); the first otherwise-unmatched heading (e.g.
 * "Definition of done", "Notes", or a custom closing section) takes
 * the definition-of-done content, and any further unmatched headings
 * are skipped — the template never invents content to fill a name.
 */
export function buildTemplateDraft(
  issue: NormalizedIssue,
  failedChecks: CheckResult[],
  sectionNames: readonly string[] = DEFAULT_IMPROVE_SECTIONS,
): DraftSection[] {
  // When the author already wrote an AC section, its lines belong to
  // the criteria section of the draft — keeping them out of Context
  // stops the draft from printing the same sentences twice.
  const sectionBody = acceptanceCriteriaSectionBody(issue.descriptionText);
  const sectionLines = new Set(sectionBody ? cleanLines(sectionBody) : []);
  const contextLines = cleanLines(issue.descriptionText).filter(
    (line) => isMeaningful(line) && !sectionLines.has(line),
  );
  // Two passes: headings that name a canonical block claim it; the
  // first unclaimed heading then takes the goal content (a structure
  // like ["Why", ..., "Wrap-up"] still opens with the goal), and the
  // next unclaimed one takes the definition of done. Anything beyond
  // that is skipped — the template never invents content for a name.
  const claimed = new Map<string, 'goal' | 'context' | 'criteria' | 'done'>();
  let goalClaimed = false;
  let doneClaimed = false;
  for (const name of sectionNames) {
    if (/acceptance criteria/i.test(name)) claimed.set(name, 'criteria');
    else if (/goal|objective|purpose/i.test(name)) {
      claimed.set(name, 'goal');
      goalClaimed = true;
    } else if (/context|background/i.test(name)) claimed.set(name, 'context');
  }
  for (const name of sectionNames) {
    if (claimed.has(name)) continue;
    if (!goalClaimed) {
      claimed.set(name, 'goal');
      goalClaimed = true;
    } else if (!doneClaimed) {
      claimed.set(name, 'done');
      doneClaimed = true;
    }
  }
  const sections: DraftSection[] = [];
  for (const name of sectionNames) {
    const kind = claimed.get(name);
    if (kind === 'criteria') {
      sections.push(buildAcceptanceCriteria(issue, contextLines, name));
    } else if (kind === 'goal') {
      sections.push(buildGoal(issue, contextLines, name));
    } else if (kind === 'context') {
      const context = buildContext(contextLines, name);
      if (context) sections.push(context);
    } else if (kind === 'done') {
      sections.push(buildDefinitionOfDone(failedChecks, name));
    }
  }
  return sections;
}
