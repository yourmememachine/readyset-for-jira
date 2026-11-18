import { describe, expect, it } from 'vitest';
import { parseThresholdInput } from '../src/lib/threshold-input';
import { toUserMessage } from '../src/lib/user-error';

describe('parseThresholdInput (A17)', () => {
  it('parses plain and padded numbers', () => {
    expect(parseThresholdInput('80')).toBe(80);
    expect(parseThresholdInput(' 60 ')).toBe(60);
    expect(parseThresholdInput('0')).toBe(0);
  });

  it('rejects empty and non-numeric input instead of coercing to 0', () => {
    expect(parseThresholdInput('')).toBeNull();
    expect(parseThresholdInput('   ')).toBeNull();
    expect(parseThresholdInput('abc')).toBeNull();
    expect(parseThresholdInput('NaN')).toBeNull();
  });
});

describe('toUserMessage (B14)', () => {
  it('maps HTTP 410 to the removed-API explanation', () => {
    expect(toUserMessage(new Error('ReadySet: searchIssues failed with HTTP 410'))).toMatch(
      /no longer supports/,
    );
  });

  it('maps HTTP 403 and 429 to actionable sentences', () => {
    expect(toUserMessage(new Error('HTTP 403'))).toMatch(/permission/);
    expect(toUserMessage(new Error('HTTP 429'))).toMatch(/rate-limiting/);
  });

  it('passes the admin-gate message through verbatim', () => {
    const message = 'Only project administrators can change ReadySet settings.';
    expect(toUserMessage(new Error(message))).toBe(message);
  });

  it('falls back to a generic sentence for unknown errors', () => {
    expect(toUserMessage(new Error('boom'))).toMatch(/Something went wrong/);
    expect(toUserMessage('string failure')).toMatch(/Something went wrong/);
  });
});
