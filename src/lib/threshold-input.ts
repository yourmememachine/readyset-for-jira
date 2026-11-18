/**
 * Parse a threshold text-field value (cross-review A17).
 *
 * UI Kit text fields hand back strings; the old save path ran
 * `Number(value)`, which turns an empty field into 0 — silently
 * redefining "Ready" for the whole project. Empty or non-numeric input
 * is now a local validation error (null) and is never sent to the
 * resolver.
 */
export function parseThresholdInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.round(value);
}
