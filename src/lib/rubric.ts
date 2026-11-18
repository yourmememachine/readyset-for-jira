/**
 * ReadySet readiness rubric — the heart of the app.
 *
 * Pure TypeScript: a {@link NormalizedIssue} goes in, a
 * {@link ReadinessScore} comes out. No I/O, no Forge imports, no clocks,
 * no randomness — the same issue always scores the same way, which is
 * what makes the score explainable on the issue, comparable on the
 * dashboard, and safe to cache.
 *
 * Scoring: each enabled check contributes its weight when it passes.
 * The total is renormalized over enabled checks only, so switching a
 * check off in project settings keeps the scale at 0–100.
 */
import {
  BUG_ISSUE_TYPES,
  CHECK_LABELS,
  CHECK_WEIGHTS,
  DEFAULT_SETTINGS,
  DESCRIPTION_MIN_CHARS,
  DUE_DATE_PRIORITIES,
  PLACEHOLDER_PHRASES,
  PLACEHOLDER_TOKENS,
  STOPWORDS,
  SUMMARY_MIN_CHARS,
  SUMMARY_MIN_SPECIFIC_TOKENS,
  TOGGLEABLE_CHECKS,
  VAGUE_WORDS,
} from './rubric-config';
import type {
  CheckId,
  CheckResult,
  Grade,
  NormalizedIssue,
  ProjectSettings,
  ReadinessScore,
} from './types';

const PLACEHOLDER_TOKEN_RE = new RegExp(
  `\\b(${PLACEHOLDER_TOKENS.join('|')})s?\\b`,
  'gi',
);
/** Hyphenated marker; `\btodo\b` can never match it (cross-review A14).
 *  The "to-do list" prose distinction is made positionally in
 *  findPlaceholderIn (round 2, F-8), not by a lookahead here — the
 *  lookahead exempted "to-do list:" headers wholesale. */
const TO_DO_RE = /\bto-do\b/gi;
const ACCEPTANCE_CRITERIA_RE = /acceptance criteria/i;
/**
 * A line that opens an acceptance-criteria section. Two shapes count —
 * a markdown heading (hash marks present), or a plain label line. The
 * phrase may carry ONE qualifier tail (war-room round 2, F-9):
 * "for|on|of" + up to 3 words, a dash + up to 3 words, or a
 * parenthetical — "Acceptance criteria for login:" is a heading. But
 * a prose sentence that merely begins with the words ("Acceptance
 * criteria are not yet written — the PM will add them Friday") is NOT
 * a heading (war-room B16): after the optional qualifier the line
 * must end or continue with a colon — arbitrary trailing prose is a
 * sentence, not a section label. The round-1 markdown shape captured
 * any trailing text as an inline body, which made the B16 sentence a
 * passing section whenever it carried hashes.
 */
const AC_QUALIFIER_TAIL = String.raw`(?:\s+(?:for|on|of)\s+(?:\S+\s+){0,2}\S+|\s*[-–—]\s*(?:\S+\s+){0,2}\S+|\s*\([^)]{1,40}\))?`;
const AC_HEADING_MD_RE = new RegExp(
  String.raw`^\s{0,3}#{1,6}\s*acceptance criteria${AC_QUALIFIER_TAIL}\s*(?::\s*(.*))?$`,
  'i',
);
const AC_HEADING_PLAIN_RE = new RegExp(
  String.raw`^\s{0,3}acceptance criteria${AC_QUALIFIER_TAIL}\s*(?::\s*(.*))?$`,
  'i',
);

/** The AC heading a line opens with, or null: `{ inline }` = text after the label. */
function matchAcHeading(line: string): { inline: string } | null {
  const md = line.match(AC_HEADING_MD_RE);
  if (md) return { inline: md[1] ?? '' };
  const plain = line.match(AC_HEADING_PLAIN_RE);
  if (plain) return { inline: plain[1] ?? '' };
  return null;
}
/** A markdown-style heading line (any level) — ends an AC section. */
const HEADING_LINE_RE = /^\s{0,3}#{1,6}\s+\S/;

function result(
  id: CheckId,
  passed: boolean,
  detail: string,
  fixHint: string,
): CheckResult {
  return { id, label: CHECK_LABELS[id], weight: CHECK_WEIGHTS[id], passed, detail, fixHint };
}

function checkDescription(issue: NormalizedIssue): CheckResult {
  const text = issue.descriptionText.trim();
  const length = text.length;
  // Distinct-token floor (war-room round 2, E #8): length alone is
  // gameable — 280 characters of repeated gibberish passed. A real
  // description uses vocabulary; ≥30 distinct tokens (length ≥2)
  // alongside the character floor is the conjunctive test.
  const distinctTokens = new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  ).size;
  const passed = length >= DESCRIPTION_MIN_CHARS && distinctTokens >= 30;
  return result(
    'description',
    passed,
    passed
      ? `Description is ${length} characters.`
      : length === 0
        ? 'Description is empty.'
        : length < DESCRIPTION_MIN_CHARS
          ? `Description is only ${length} characters (needs ${DESCRIPTION_MIN_CHARS}+).`
          : `Description is long enough but uses only ${distinctTokens} distinct words (needs 30+).`,
    'Write a real description: the goal, the context, and what "done" looks like.',
  );
}

/** CJK characters (Han, kana, Hangul) — unsegmented scripts. */
const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Meaningful-content test shared by the AC check and the placeholder
 * check: after removing placeholder markers, is there real text left?
 * A body that is empty or placeholder-only does not count as content
 * (cross-review A5/A12) — otherwise "Acceptance criteria: TBD" would
 * outscore honestly omitting the section.
 *
 * Round 2 (E #8): the test is CONJUNCTIVE. The old form — ≥3
 * alphanumeric characters after stripping — passed "xyz" as written
 * acceptance criteria. Now: marker-stripped length ≥ 8 AND ≥ 2
 * distinct tokens (token length ≥ 2); OR ≥ 8 CJK characters, since
 * unsegmented scripts yield no whitespace tokens (the B14 Japanese
 * case, which must keep passing).
 */
function hasMeaningfulContent(text: string): boolean {
  const withoutMarkers = text
    .replace(PLACEHOLDER_TOKEN_RE, ' ')
    .replace(TO_DO_RE, ' ')
    .replace(/to be (decided|determined|confirmed)/gi, ' ');
  const cjkCount = (withoutMarkers.match(CJK_CHAR_RE) ?? []).length;
  if (cjkCount >= 8) return true;
  // Unicode letters/digits (war-room B14): stripping everything but
  // a-z0-9 made non-English content fail by construction.
  const strippedLength = withoutMarkers.replace(/[^\p{L}\p{N}]+/gu, '').length;
  if (strippedLength < 8) return false;
  const distinctTokens = new Set(
    withoutMarkers
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2),
  );
  return distinctTokens.size >= 2;
}

/**
 * Find an acceptance-criteria *section* in the description and return
 * its body, or null when there is no section. The phrase must appear
 * as a heading (start of a line, optional markdown hashes / trailing
 * colon) — a bare mention mid-sentence is not a section
 * (cross-review A5). The body runs until the next heading line.
 *
 * Exported for the Improve template (phase 2a), which reuses this
 * exact definition when harvesting criteria the author already wrote
 * — one definition of "the AC section", owned by the rubric.
 */
export function acceptanceCriteriaSectionBody(descriptionText: string): string | null {
  const lines = descriptionText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = matchAcHeading(line);
    if (!heading) continue;
    const bodyLines: string[] = [];
    const inline = heading.inline.trim();
    if (inline) bodyLines.push(inline);
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (HEADING_LINE_RE.test(next) || matchAcHeading(next)) break;
      bodyLines.push(next);
    }
    return bodyLines.join('\n').trim();
  }
  return null;
}

function checkAcceptanceCriteria(issue: NormalizedIssue): CheckResult {
  const fieldText = issue.acceptanceCriteriaText?.trim() ?? '';
  if (fieldText.length >= 10 && hasMeaningfulContent(fieldText)) {
    return result(
      'acceptance-criteria',
      true,
      'Acceptance criteria field is filled in.',
      '',
    );
  }
  const sectionBody = acceptanceCriteriaSectionBody(issue.descriptionText);
  if (sectionBody !== null && hasMeaningfulContent(sectionBody)) {
    return result(
      'acceptance-criteria',
      true,
      'Description contains an acceptance criteria section.',
      '',
    );
  }
  const mentioned = ACCEPTANCE_CRITERIA_RE.test(issue.descriptionText) || fieldText.length > 0;
  return result(
    'acceptance-criteria',
    false,
    mentioned
      ? 'Acceptance criteria are mentioned but not actually written.'
      : 'No acceptance criteria section in the description.',
    'Add an "Acceptance criteria" section listing how reviewers will verify this work.',
  );
}

function checkEstimate(issue: NormalizedIssue): CheckResult {
  if (issue.storyPoints !== null && issue.storyPoints > 0) {
    return result('estimate', true, `Story points set (${issue.storyPoints}).`, '');
  }
  if (issue.originalEstimateSeconds !== null && issue.originalEstimateSeconds > 0) {
    const hours = Math.round((issue.originalEstimateSeconds / 3600) * 10) / 10;
    return result('estimate', true, `Time estimate set (${hours}h).`, '');
  }
  return result(
    'estimate',
    false,
    'No story points or time estimate.',
    'Estimate the work (story points or time) before it enters a sprint.',
  );
}

function checkPriority(issue: NormalizedIssue): CheckResult {
  const priority = issue.priority?.trim() ?? '';
  const passed = priority.length > 0;
  return result(
    'priority',
    passed,
    passed ? `Priority is ${priority}.` : 'Priority is not set.',
    'Set a priority so the team knows how this ranks against other work.',
  );
}

function checkAssignee(issue: NormalizedIssue): CheckResult {
  const assignee = issue.assignee?.trim() ?? '';
  const passed = assignee.length > 0;
  return result(
    'assignee',
    passed,
    passed ? `Assigned to ${assignee}.` : 'Issue is unassigned.',
    'Assign an owner — unassigned work is nobody’s work.',
  );
}

function checkLabelsOrComponents(issue: NormalizedIssue): CheckResult {
  const total = issue.labels.length + issue.components.length;
  const passed = total > 0;
  const parts: string[] = [];
  if (issue.labels.length > 0) parts.push(`labels: ${issue.labels.join(', ')}`);
  if (issue.components.length > 0) parts.push(`components: ${issue.components.join(', ')}`);
  return result(
    'labels-or-components',
    passed,
    passed ? parts.join('; ') + '.' : 'No labels and no component.',
    'Add at least one label or component so the work is classifiable and routable.',
  );
}

function checkLinkedWork(issue: NormalizedIssue): CheckResult {
  if (issue.linkedIssueCount > 0) {
    return result(
      'linked-work',
      true,
      `${issue.linkedIssueCount} linked issue${issue.linkedIssueCount === 1 ? '' : 's'}.`,
      '',
    );
  }
  if (issue.parentKey) {
    return result('linked-work', true, `Has parent ${issue.parentKey}.`, '');
  }
  if (issue.epicKey) {
    return result('linked-work', true, `Belongs to epic ${issue.epicKey}.`, '');
  }
  return result(
    'linked-work',
    false,
    'No linked issues, parent, or epic.',
    'Link related work, or place the issue under its parent/epic, so dependencies are visible.',
  );
}

/**
 * Does this `todo` occurrence read as an unresolved marker, or as the
 * ordinary product noun ("todo list")? Markers appear as TODO in caps,
 * at the start of a line (optionally bulleted), or followed by a colon
 * (cross-review A13). Mid-sentence lowercase "todo" — "Add todo list
 * sharing" — is vocabulary, not a marker.
 */
function isTodoMarker(text: string, index: number, match: string): boolean {
  if (match !== match.toLowerCase()) return true; // TODO / Todo-style emphasis
  const before = text.slice(0, index);
  const lineStart = before.lastIndexOf('\n') + 1;
  if (/^\s*(?:[-*•]\s*)?$/.test(before.slice(lineStart))) return true;
  const after = text.slice(index + match.length).trimStart();
  return after.startsWith(':');
}

/**
 * Is this "todo list" / "to-do list" occurrence the product noun
 * rather than a marker (war-room round 2, F-8)? The prose reading
 * applies ONLY when the token is not all-caps AND the same-line
 * remainder after "list" is non-empty and does not start with a
 * colon: "Todo list sharing is broken" is prose, but "TODO list:
 * finish the docs" and a bare header "Todo list:" are markers. The
 * round-1 guard skipped every "todo list" — exempting real markers
 * wholesale.
 */
function isProseListPhrase(text: string, matchEnd: number, token: string): boolean {
  const after = text.slice(matchEnd);
  const listMatch = /^\s+list\b/i.exec(after);
  if (!listMatch) return false;
  const remainder = (after.slice(listMatch[0].length).split('\n')[0] ?? '').trim();
  const allCaps = token === token.toUpperCase() && token !== token.toLowerCase();
  return !allCaps && remainder.length > 0 && !remainder.startsWith(':');
}

/**
 * Bounded homoglyph map (round 2, E #10): Cyrillic/Greek lookalikes
 * for the letters the placeholder tokens actually use, so "tоdo"
 * with a Cyrillic о scans as "todo". Deliberately small — a general
 * confusables table is a maintenance trap, and the token list is
 * closed.
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  'а': 'a', 'с': 'c', 'е': 'e', 'о': 'o', 'р': 'p', 'х': 'x',
  'і': 'i', 'ο': 'o', 'а́': 'a',
  'А': 'A', 'С': 'C', 'Е': 'E', 'О': 'O', 'Р': 'P', 'Х': 'X',
};
const HOMOGLYPH_RE = /[асеорхіοАЕСОРХ]/g;

/**
 * Scan variants of a text for placeholder matching (round 2, E #10):
 * the text with zero-width characters stripped (U+200B–D, U+FEFF —
 * "T\u200bBD" must scan as "TBD"), and a further variant with
 * intra-token punctuation collapsed and homoglyphs folded
 * ("T.B.D", "tоdo"). Line structure is preserved in both, so the
 * positional prose guards still see the real context.
 */
function placeholderScanVariants(text: string): string[] {
  const noZeroWidth = text.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const collapsed = noZeroWidth
    .replace(/(\p{L})[.\-_·]+(?=\p{L})/gu, '$1')
    .replace(HOMOGLYPH_RE, (ch) => HOMOGLYPH_MAP[ch] ?? ch);
  return collapsed === noZeroWidth ? [noZeroWidth] : [noZeroWidth, collapsed];
}

function findPlaceholderIn(text: string): string | null {
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_TOKEN_RE.exec(text)) !== null) {
    const token = (match[1] ?? '').toLowerCase();
    if (token === 'todo') {
      if (isProseListPhrase(text, match.index + match[0].length, match[0])) continue;
      if (!isTodoMarker(text, match.index, match[0])) continue;
    }
    return match[0];
  }
  TO_DO_RE.lastIndex = 0;
  let toDoMatch: RegExpExecArray | null;
  while ((toDoMatch = TO_DO_RE.exec(text)) !== null) {
    if (isProseListPhrase(text, toDoMatch.index + toDoMatch[0].length, toDoMatch[0])) continue;
    return toDoMatch[0];
  }
  const lower = text.toLowerCase();
  for (const phrase of PLACEHOLDER_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

function findPlaceholder(text: string): string | null {
  for (const variant of placeholderScanVariants(text)) {
    const found = findPlaceholderIn(variant);
    if (found) return found;
  }
  return null;
}

/**
 * Whether a text carries an unresolved placeholder marker, under the
 * exact rules the no-placeholders check applies. Exported for the
 * Improve draft parser (war-room C5): an LLM draft containing "TBD"
 * would fail the very check it exists to fix, so the parser rejects
 * it and the caller falls back to the marker-stripping template.
 */
export function containsPlaceholder(text: string): boolean {
  return findPlaceholder(text) !== null;
}

function checkNoPlaceholders(issue: NormalizedIssue): CheckResult {
  const targets: Array<[string, string]> = [
    ['Summary', issue.summary],
    ['Description', issue.descriptionText],
    // The dedicated AC field is content too: placeholder text there was
    // previously invisible to this check (cross-review A12).
    ['Acceptance criteria field', issue.acceptanceCriteriaText ?? ''],
  ];
  for (const [label, text] of targets) {
    const found = findPlaceholder(text);
    if (found) {
      return result(
        'no-placeholders',
        false,
        `${label} still contains the placeholder "${found}".`,
        'Replace placeholder text with the real requirement before sprint planning.',
      );
    }
  }
  return result('no-placeholders', true, 'No TBD/TODO-style placeholders found.', '');
}

function specificTokens(summary: string): string[] {
  const lower = summary.toLowerCase();
  // Unsegmented scripts need real segmentation (round 2, F-20):
  // splitting Japanese on non-letter boundaries yields ONE token for
  // a whole sentence, so the specificity floor was unreachable.
  if (CJK_CHAR_RE.test(lower)) {
    CJK_CHAR_RE.lastIndex = 0;
    try {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
      return [
        ...new Set(
          [...segmenter.segment(lower)]
            .filter((part) => part.isWordLike)
            .map((part) => part.segment)
            .filter((token) => token.length >= 2 && !VAGUE_WORDS.has(token) && !STOPWORDS.has(token)),
        ),
      ];
    } catch {
      // Segmenter unavailable: fall through to the boundary split.
    }
  }
  CJK_CHAR_RE.lastIndex = 0;
  // Distinct tokens only: repeating one specific word three times is
  // not specificity (cross-review A15).
  return [
    ...new Set(
      lower
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 3 && !VAGUE_WORDS.has(token) && !STOPWORDS.has(token)),
    ),
  ];
}

function checkSummaryQuality(issue: NormalizedIssue): CheckResult {
  const summary = issue.summary.trim();
  if (summary.length < SUMMARY_MIN_CHARS) {
    return result(
      'summary-quality',
      false,
      `Summary is only ${summary.length} characters (needs ${SUMMARY_MIN_CHARS}+).`,
      'Write a summary that names the thing being changed and why.',
    );
  }
  const specific = specificTokens(summary);
  const passed = specific.length >= SUMMARY_MIN_SPECIFIC_TOKENS;
  return result(
    'summary-quality',
    passed,
    passed
      ? 'Summary names specific work.'
      : 'Summary is built from vague words only ("fix bug", "update stuff" style).',
    'Name the concrete system, behaviour, or user outcome — not just "fix" or "update".',
  );
}

function checkDueDate(issue: NormalizedIssue): CheckResult {
  const priority = (issue.priority ?? '').trim().toLowerCase();
  if (!DUE_DATE_PRIORITIES.has(priority)) {
    return result(
      'due-date',
      true,
      issue.priority
        ? `Due date not required at priority ${issue.priority}.`
        : 'Due date not required (no high priority set).',
      '',
    );
  }
  const passed = issue.dueDate !== null && issue.dueDate.trim() !== '';
  return result(
    'due-date',
    passed,
    passed
      ? `Due date set (${issue.dueDate}) for priority ${issue.priority}.`
      : `Priority is ${issue.priority} but no due date is set.`,
    'High-priority work needs a due date so its deadline is explicit.',
  );
}

/**
 * A line that opens a steps-to-reproduce section (bug pack, v3).
 * Same heading discipline as the AC pair (round 2, F-9): an optional
 * qualifier tail, then the line must end or continue with a colon —
 * a prose sentence that merely begins with the words ("Steps to
 * reproduce the issue are unknown…") is NOT a heading (upgrade
 * cross-review A3).
 */
const REPRO_HEADING_MD_RE = new RegExp(
  String.raw`^\s{0,3}#{1,6}\s*(steps to reproduce|reproduction steps|how to reproduce|repro steps)${AC_QUALIFIER_TAIL}\s*(?::\s*(.*))?$`,
  'i',
);
const REPRO_HEADING_PLAIN_RE = new RegExp(
  String.raw`^\s{0,3}(steps to reproduce|reproduction steps|how to reproduce|repro steps)${AC_QUALIFIER_TAIL}\s*(?::\s*(.*))?$`,
  'i',
);

/** Body of a steps-to-reproduce section, mirroring the AC extractor. */
function reproSectionBody(descriptionText: string): string | null {
  const lines = descriptionText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = line.match(REPRO_HEADING_MD_RE) ?? line.match(REPRO_HEADING_PLAIN_RE);
    if (!heading) continue;
    const bodyLines: string[] = [];
    const inline = (heading[2] ?? '').trim();
    if (inline) bodyLines.push(inline);
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (
        HEADING_LINE_RE.test(next) ||
        REPRO_HEADING_MD_RE.test(next) ||
        REPRO_HEADING_PLAIN_RE.test(next)
      ) {
        break;
      }
      bodyLines.push(next);
    }
    return bodyLines.join('\n').trim();
  }
  return null;
}

/** Line-anchored "Expected:" / "Actual:" labels (upgrade review A4). */
const EXPECTED_LABEL_RE = /(^|\n)\s*expected\s*[:\-–]/i;
const ACTUAL_LABEL_RE = /(^|\n)\s*actual\s*[:\-–]/i;

/**
 * Confession lines (war-room round 2, F-3): text that states the
 * content is ABSENT — "not documented in the issue", "the issue does
 * not state the expected result". The Improve template writes exactly
 * these into its repro scaffolding when the source issue has no
 * steps; they are honest requests for information, not evidence of
 * it, so the evidence test below removes them before measuring. The
 * template imports this same pattern family (via its scaffold
 * wording) so what it emits can never drift into creditable text.
 */
export const CONFESSION_LINE_RE =
  /\b(not (yet )?(documented|stated|specified)|does not (state|specify|document)|to be (added|provided) by)\b/i;

/** A text with confession lines removed — what actually evidences content. */
export function evidenceText(text: string): string {
  return text
    .split('\n')
    .filter((line) => !CONFESSION_LINE_RE.test(line))
    .join('\n');
}

/**
 * Bug pack (upgrade pack, review #1): bug-type issues must document how
 * to reproduce the defect. Returns null for every other issue type —
 * the check is then excluded from scoring entirely rather than passed
 * by default, so a story's denominator never includes bug criteria.
 * Passes on a steps-to-reproduce section with a real body, or on an
 * expected/actual pairing in a substantive description.
 */
function checkReproSteps(issue: NormalizedIssue): CheckResult | null {
  if (!BUG_ISSUE_TYPES.has(issue.issueType.trim().toLowerCase())) return null;
  const body = reproSectionBody(issue.descriptionText);
  // Evidence, not scaffolding (round 2, F-3): a section whose body is
  // only confession lines ("steps were not documented…") documents
  // an ABSENCE — the round-1 template fabricated exactly such a body
  // and the check paid out 10 points for it.
  if (body !== null && hasMeaningfulContent(evidenceText(body))) {
    return result('repro-steps', true, 'Reproduction steps are documented.', '');
  }
  const text = issue.descriptionText;
  if (
    EXPECTED_LABEL_RE.test(text) &&
    ACTUAL_LABEL_RE.test(text) &&
    hasMeaningfulContent(evidenceText(text))
  ) {
    return result(
      'repro-steps',
      true,
      'Expected and actual behaviour are both described.',
      '',
    );
  }
  return result(
    'repro-steps',
    false,
    'Bug has no documented reproduction steps.',
    'Add a "Steps to reproduce" section: the exact steps, the expected result, and what actually happens.',
  );
}

const ALL_CHECKS: ReadonlyArray<(issue: NormalizedIssue) => CheckResult | null> = [
  checkDescription,
  checkAcceptanceCriteria,
  checkEstimate,
  checkPriority,
  checkAssignee,
  checkLabelsOrComponents,
  checkLinkedWork,
  checkNoPlaceholders,
  checkSummaryQuality,
  checkDueDate,
  checkReproSteps,
];

export function isCheckEnabled(id: CheckId, settings: ProjectSettings): boolean {
  // Wave 2: every check is toggleable. A missing key (legacy settings
  // object) means enabled — normalizeSettings fills the full map on
  // every read/save, so this only matters for hand-built settings.
  return settings.checksEnabled[id] !== false;
}

/** The weight in force for a check under these settings. */
export function weightFor(id: CheckId, settings: ProjectSettings): number {
  const weight = settings.weights?.[id];
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0
    ? weight
    : CHECK_WEIGHTS[id];
}

export function gradeForScore(score: number, settings: ProjectSettings): Grade {
  if (score >= settings.readyThreshold) return 'ready';
  if (score >= settings.almostThreshold) return 'almost';
  return 'not-ready';
}

/**
 * Score one issue. Deterministic and side-effect free.
 */
export function scoreIssue(
  issue: NormalizedIssue,
  settings: ProjectSettings = DEFAULT_SETTINGS,
): ReadinessScore {
  const checks = ALL_CHECKS.map((check) => check(issue))
    .filter((check): check is CheckResult => check !== null && isCheckEnabled(check.id, settings))
    // Wave 2: weights come from project settings, not the static
    // table — re-stamp each result so every downstream consumer
    // (next-fix ordering, projections, panels) sees the weight in
    // force.
    .map((check) => ({ ...check, weight: weightFor(check.id, settings) }));
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earnedWeight = checks.reduce(
    (sum, check) => sum + (check.passed ? check.weight : 0),
    0,
  );
  const score = totalWeight === 0 ? 0 : Math.round((100 * earnedWeight) / totalWeight);
  return {
    issueKey: issue.key,
    score,
    grade: gradeForScore(score, settings),
    checks,
  };
}

/**
 * The single highest-value fix for an issue (upgrade pack, review #6):
 * the failing check worth the most points. Ties break by rubric order
 * (the checks array order), so the answer is deterministic. Null when
 * nothing is failing.
 */
export function nextFixFor(checks: CheckResult[]): CheckResult | null {
  let best: CheckResult | null = null;
  for (const check of checks) {
    if (check.passed) continue;
    if (best === null || check.weight > best.weight) best = check;
  }
  return best;
}

/**
 * The score an issue would carry if exactly one check flipped to
 * passing, computed with scoreIssue's own renormalization and
 * rounding (upgrade cross-review A2 — the panel's "fix this next"
 * gain must be the real renormalized gain, not the raw weight: on a
 * bug's 110-point denominator a 10-point check gains 9).
 */
export function projectedScoreIfFixed(checks: CheckResult[], checkId: CheckId): number {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  if (totalWeight === 0) return 0;
  const earnedWeight = checks.reduce(
    (sum, check) => sum + (check.passed || check.id === checkId ? check.weight : 0),
    0,
  );
  return Math.round((100 * earnedWeight) / totalWeight);
}
