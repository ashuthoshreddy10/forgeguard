/**
 * utils.ts — General-purpose utility functions.
 *
 * SEEDED ISSUE #4 (Stub / missing feature):
 *   formatCurrency() is declared but returns a placeholder.
 *   Callers in api.ts depend on it, so its absence causes incorrect output.
 *   The feature request is: implement formatCurrency() with proper locale support.
 *
 * SEEDED ISSUE #5 (Potential security / validation gap):
 *   sanitizeInput() trims whitespace but does NOT strip HTML tags or script content.
 *   User-supplied strings passed through sanitizeInput() could contain XSS payloads
 *   if they are later rendered in a browser context.
 *
 * SEEDED ISSUE #6 (Duplicate constant — see also pricing.ts):
 *   SALES_TAX duplicates TAX_RATE from pricing.ts. Should come from a shared config.
 */

/** Sales tax rate (8%) — duplicated from pricing.ts, see seeded issue #6. */
export const SALES_TAX = 0.08;

/**
 * Format a number as a USD currency string.
 *
 * SEEDED STUB: This function is not yet implemented.
 * It should return a properly locale-formatted currency string.
 * Currently returns an empty placeholder, which causes incorrect output in the API.
 *
 * TODO: Implement using Intl.NumberFormat or equivalent.
 */
export function formatCurrency(_amount: number): string {
  // TODO: implement — currently returns placeholder
  return '';
}

/**
 * Sanitize a user-supplied string before storage or display.
 *
 * SEEDED SECURITY ISSUE: Only trims whitespace.
 * Does not remove HTML tags, script injection, or control characters.
 * Strings processed here are later embedded in API responses read by frontend code.
 *
 * @param input - Raw user-supplied string.
 * @returns Trimmed string (insufficient sanitization).
 */
export function sanitizeInput(input: string): string {
  // BUG: only trims — no HTML stripping, no tag removal
  return input.trim();
}

/**
 * Clamp a numeric value between min and max (inclusive).
 * This is a correct utility function included as a reference.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse a comma-separated list of tags from a raw string.
 * Returns an empty array for blank input.
 */
export function parseTags(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Generate a simple alphanumeric ID of the given length.
 * NOT suitable for security-sensitive use (not cryptographic).
 */
export function generateId(length = 8): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
