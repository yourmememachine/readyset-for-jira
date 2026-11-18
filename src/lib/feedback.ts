/**
 * "Report an incorrect score" link for the issue panel (Wave 2).
 * A prefilled mailto: the reporter sends from their own mail client,
 * so the report carries their identity and the issue context without
 * ReadySet storing or transmitting anything.
 */
import type { Grade } from './types';

export const SUPPORT_EMAIL = 'tdilip2501@gmail.com';

const GRADE_TEXT: Record<Grade, string> = {
  ready: 'Ready',
  almost: 'Almost ready',
  'not-ready': 'Not ready',
};

export function scoreFeedbackHref(issueKey: string, score: number, grade: Grade): string {
  const subject = `ReadySet score report — ${issueKey}`;
  const body = [
    `Issue: ${issueKey}`,
    `ReadySet score shown: ${score} (${GRADE_TEXT[grade]})`,
    '',
    'What looks wrong about this score?',
    '',
  ].join('\n');
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
