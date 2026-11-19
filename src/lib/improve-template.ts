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
import { acceptanceCriteriaSectionBody, containsPlaceholder } from './rubric';
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
  // Hyphenated marker (round 2, E #11): MARKER_TOKEN_RE's \b can
  // never see "to-do", so a harvested line carrying it produced a
  // draft that flagged ITSELF on the no-placeholders check. Strip it
  // under the rubric's own prose rule: "to-do list" as a product noun
  // (not all-caps, followed by more prose, no colon) is kept.
  cleaned = cleaned.replace(/\bto-do\b/gi, (match: string, offset: number, full: string) => {
    const after = full.slice(offset + match.length);
    const listMatch = /^\s+list\b/i.exec(after);
    if (listMatch) {
      const remainder = after.slice(listMatch[0].length).trim();
      const allCaps = match === match.toUpperCase() && match !== match.toLowerCase();
      if (!allCaps && remainder.length > 0 && !remainder.startsWith(':')) return match;
    }
    return ' ';
  });
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
  // Unicode letters/digits, as in the rubric (B14).
  return text.replace(/[^\p{L}\p{N}]+/gu, '').length >= 20;
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

/** Split one long line into word-boundary chunks of at most `cap` chars. */
function chunkLine(line: string, cap: number): string[] {
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > cap) {
    const cut = rest.lastIndexOf(' ', cap);
    const at = cut > cap / 2 ? cut : cap;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function buildContext(contextLines: string[], heading: string): DraftSection | null {
  if (contextLines.length === 0) return null;
  // Preserve the author's own words (markers stripped), grouped back
  // into paragraphs so the draft stays readable. Bounded (round 2,
  // E #11): no paragraph over ~2,000 chars and no Context over
  // ~4,000 — the old grouping let one unbounded line (a pasted log, a
  // minified blob) become a single giant paragraph.
  const boundedLines = contextLines.flatMap((line) => chunkLine(line, 2000));
  const paragraphs: string[] = [];
  let buffer: string[] = [];
  let total = 0;
  for (const line of boundedLines) {
    if (total + line.length > 4000 && paragraphs.length > 0) break;
    buffer.push(line);
    total += line.length;
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

/**
 * Steps-to-reproduce section for a bug whose repro check fails.
 *
 * Round 2 (F-3) rewrote this builder on an honesty rule: the round-1
 * version FABRICATED a passing check — it manufactured numbered
 * "steps" from arbitrary prose sentences, an "Expected:" line
 * pointing at the draft's own criteria, and an "Actual:" line quoting
 * the summary, and the rubric paid out the repro weight for content
 * the reporter never wrote. The section now contains only:
 * - steps transcribed verbatim from step-like lines the author
 *   actually wrote (numbered or bulleted list lines in the issue), and
 * - Expected/Actual lines quoted verbatim when the issue itself
 *   carries them in labelled form.
 * When the issue has neither, the section is scaffolding that says so
 * in confession lines ("not documented in the issue") — which the
 * rubric's evidence test strips before measuring, so the scaffold
 * earns NO credit. It exists to tell the reporter exactly what to
 * add, not to pretend they added it.
 */
function buildReproSection(issue: NormalizedIssue): DraftSection {
  const rawLines = issue.descriptionText.split('\n');
  const steps: string[] = [];
  for (const rawLine of rawLines) {
    const item = rawLine.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)$/);
    if (!item) continue;
    const text = cleanLine(item[1] ?? '');
    if (text.length >= 10 && !steps.includes(text)) steps.push(text);
    if (steps.length >= 5) break;
  }
  const paragraphs: string[] = [];
  if (steps.length > 0) {
    steps.forEach((step, index) => {
      paragraphs.push(`${index + 1}. ${ensureSentence(step)}`);
    });
  } else {
    paragraphs.push('Reproduction steps were not documented in the issue.');
  }
  const expected = issue.descriptionText.match(/^\s*expected\s*[:\-–]\s*(.+)$/im);
  const actual = issue.descriptionText.match(/^\s*actual\s*[:\-–]\s*(.+)$/im);
  if (expected?.[1] && actual?.[1]) {
    paragraphs.push(
      `Expected: ${ensureSentence(cleanLine(expected[1]))}`,
      `Actual: ${ensureSentence(cleanLine(actual[1]))}`,
    );
  } else if (steps.length === 0) {
    paragraphs.push('The issue does not state the expected result or the actual behaviour.');
  }
  return { heading: 'Steps to reproduce', paragraphs };
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
  // Bug pack (C3): a bug failing repro-steps gets its repro
  // section appended — it is not part of the configured structure
  // (stories never see it), it is the draft addressing a failing
  // check the configured sections cannot express.
  if (failedChecks.some((check) => check.id === 'repro-steps')) {
    sections.push(buildReproSection(issue));
  }
  // Post-build validation (round 2, E #11): no paragraph the template
  // emits may trip the placeholder scan — a draft that flags itself
  // teaches users the tool writes failing text. Harvested lines are
  // marker-stripped by cleanLine, so anything caught here is dropped,
  // never shipped.
  return sections.map((section) => ({
    ...section,
    paragraphs: section.paragraphs.filter((paragraph) => !containsPlaceholder(paragraph)),
  }));
}

/** The Acceptance criteria section of a full template draft (Wave 3 partial Improve). */
export function templateAcSection(
  issue: NormalizedIssue,
  failedChecks: CheckResult[],
  sectionNames: readonly string[] = DEFAULT_IMPROVE_SECTIONS,
): DraftSection {
  const draft = buildTemplateDraft(issue, failedChecks, sectionNames);
  const ac = draft.find((section) => /^acceptance criteria\b/i.test(section.heading));
  if (ac) return ac;
  // Unreachable by construction (the structure always contains an AC
  // heading) — but never return undefined to a write path.
  return buildAcceptanceCriteria(issue, cleanLines(issue.descriptionText), 'Acceptance criteria');
}

/**
 * Derive a specific summary from the issue's own text (Wave 3 summary
 * Improve, template path): the first sentence of the description's
 * most summary-like section, tidied and length-capped. Sections are
 * preferred in intro → Goal → Context → other → acceptance-criteria
 * order, because the flattened description text STARTS with heading
 * words — the first live derivation (2026-11-18) glued the criteria
 * together and cut mid-word. Truncation always lands on a word
 * boundary. Returns null when the issue carries no usable material —
 * an empty issue gets no invented summary.
 */
export function buildSummaryFromIssue(
  issue: NormalizedIssue,
  sections: DraftSection[] = [],
): string | null {
  const rank = (heading: string): number => {
    if (heading.trim() === '') return 0;
    if (/^(goal|objective|purpose)\b/i.test(heading)) return 1;
    if (/^(context|background)\b/i.test(heading)) return 2;
    if (/^acceptance criteria\b/i.test(heading)) return 4;
    return 3;
  };
  const paragraphs = [...sections]
    .sort((a, b) => rank(a.heading) - rank(b.heading))
    .flatMap((section) => section.paragraphs)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length >= 10);
  const source = paragraphs[0] ?? issue.descriptionText.replace(/\s+/g, ' ').trim();
  if (source.length < 10) return null;
  const sentenceMatch = source.match(/^[^.!?]{10,}?[.!?](?=\s|$)/);
  let candidate = (sentenceMatch ? sentenceMatch[0] : source).trim();
  if (candidate.length > 200) {
    const cut = candidate.slice(0, 200);
    const lastSpace = cut.lastIndexOf(' ');
    candidate = (lastSpace > 10 ? cut.slice(0, lastSpace) : cut).trim();
  }
  candidate = candidate.replace(/[.!?]+$/, '').trim();
  if (candidate.length < 10 || candidate.length > 200) return null;
  // The rubric's own placeholder scan (round 2, E #9): the private
  // regex this replaces was narrower, so a derived summary could
  // carry "TBC" straight into a failing no-placeholders check.
  if (containsPlaceholder(candidate)) return null;
  if (candidate.toLowerCase() === issue.summary.trim().toLowerCase()) return null;
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}
