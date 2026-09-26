/**
 * pricing.test.ts — Tests for the pricing module.
 *
 * NOTE: These tests intentionally cover ONLY happy-path cases.
 * The boundary cases for discountRate > 100 and < 0 are NOT tested.
 * This is a seeded gap that ForgeGuard's TestEngineer agent will detect.
 */

import { describe, it, expect } from 'vitest';
import { calculateDiscount, applyOrderDiscount, formatPrice } from '../src/pricing.js';
import type { LineItem } from '../src/pricing.js';

describe('calculateDiscount', () => {
  it('applies a 10% discount correctly', () => {
    expect(calculateDiscount(100, 10)).toBeCloseTo(90);
  });

  it('applies 0% discount — price unchanged', () => {
    expect(calculateDiscount(50, 0)).toBeCloseTo(50);
  });

  it('applies 100% discount — price becomes zero', () => {
    expect(calculateDiscount(200, 100)).toBeCloseTo(0);
  });

  it('applies 25% discount', () => {
    expect(calculateDiscount(80, 25)).toBeCloseTo(60);
  });

  // MISSING TEST: discountRate = 150 should clamp to 100 and return 0
  // MISSING TEST: discountRate = -10 should clamp to 0 and return originalPrice
  // These gaps are intentional for ForgeGuard to discover.
});

describe('applyOrderDiscount', () => {
  const items: LineItem[] = [
    { name: 'Widget', quantity: 2, unitPrice: 10 },
    { name: 'Gadget', quantity: 1, unitPrice: 30 },
  ];

  it('calculates subtotal, discount, tax, and total correctly', () => {
    const result = applyOrderDiscount(items, 10);
    // subtotal = 2*10 + 1*30 = 50
    // discountedSubtotal = 50 * 0.9 = 45
    // discountAmount = 5
    // taxAmount = 45 * 0.08 = 3.6
    // total = 48.6
    expect(result.subtotal).toBeCloseTo(50);
    expect(result.discountAmount).toBeCloseTo(5);
    expect(result.taxAmount).toBeCloseTo(3.6);
    expect(result.total).toBeCloseTo(48.6);
  });

  it('returns correct total for 0% discount', () => {
    const result = applyOrderDiscount(items, 0);
    expect(result.discountAmount).toBeCloseTo(0);
    expect(result.total).toBeCloseTo(50 * 1.08);
  });

  it('handles empty items array', () => {
    const result = applyOrderDiscount([], 10);
    expect(result.subtotal).toBe(0);
    expect(result.total).toBe(0);
  });

  // MISSING TEST: discountRate=150 → negative total (bug not caught)
});

describe('formatPrice', () => {
  it('formats a price with two decimal places', () => {
    expect(formatPrice(9.5)).toBe('$9.50');
    expect(formatPrice(100)).toBe('$100.00');
    expect(formatPrice(0.1 + 0.2)).toMatch(/^\$0\.30/);
  });
});
