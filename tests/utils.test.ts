/**
 * utils.test.ts — Tests for the utils module.
 *
 * NOTE: formatCurrency is NOT tested here because it is currently a stub.
 * sanitizeInput tests cover only the trim behaviour, not HTML injection.
 * These gaps are intentional for ForgeGuard discovery.
 */

import { describe, it, expect } from 'vitest';
import { clamp, parseTags, generateId, sanitizeInput } from '../src/utils.js';

describe('clamp', () => {
  it('returns value when within range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps to min', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('clamps to max', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('handles boundary values', () => {
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('parseTags', () => {
  it('parses comma-separated tags', () => {
    expect(parseTags('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace around tags', () => {
    expect(parseTags(' foo , bar ')).toEqual(['foo', 'bar']);
  });

  it('returns empty array for blank input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   ')).toEqual([]);
  });

  it('filters out empty segments', () => {
    expect(parseTags('a,,b')).toEqual(['a', 'b']);
  });
});

describe('generateId', () => {
  it('returns a string of the requested length', () => {
    expect(generateId(8)).toHaveLength(8);
    expect(generateId(16)).toHaveLength(16);
  });

  it('defaults to length 8', () => {
    expect(generateId()).toHaveLength(8);
  });

  it('contains only alphanumeric characters', () => {
    const id = generateId(50);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('sanitizeInput', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });

  it('returns empty string for blank input', () => {
    expect(sanitizeInput('  ')).toBe('');
  });

  // MISSING TEST: sanitizeInput('<script>alert(1)</script>') should strip HTML
  // This gap is intentional — ForgeGuard security analyst will flag it.
});
