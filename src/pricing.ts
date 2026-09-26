/**
 * pricing.ts — Pricing and discount calculation module.
 *
 * SEEDED ISSUE #1 (Bug):
 *   calculateDiscount() does not clamp the discount rate to [0, 100].
 *   If a caller passes rate=150, the function returns a negative price,
 *   which downstream code (applyOrderDiscount) silently accepts.
 *   Expected behaviour: clamp rate to [0, 100] before applying.
 *
 * SEEDED ISSUE #2 (Missing test):
 *   No test covers the boundary case where rate > 100 or rate < 0.
 *   Tests only cover the happy path (rate=10, rate=0).
 *
 * SEEDED ISSUE #3 (Maintainability):
 *   TAX_RATE is duplicated here and in utils.ts (0.08 vs 0.08 but named differently).
 *   Should be a single shared constant from a config module.
 */

/** Tax rate applied to final prices (8%). */
const TAX_RATE = 0.08;

export interface LineItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderSummary {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

/**
 * Calculate the discounted price for a single item.
 *
 * @param originalPrice - The original price in USD.
 * @param discountRate  - The discount percentage (e.g. 10 means 10% off).
 * @returns The price after applying the discount.
 *
 * BUG: No validation on discountRate. Values >100 produce negative prices.
 */
export function calculateDiscount(originalPrice: number, discountRate: number): number {
  // BUG: should clamp discountRate to [0, 100] here
  return originalPrice * (1 - discountRate / 100);
}

/**
 * Apply a discount rate to all line items in an order and return a summary.
 *
 * @param items        - Array of line items.
 * @param discountRate - Discount percentage applied to each item.
 */
export function applyOrderDiscount(items: LineItem[], discountRate: number): OrderSummary {
  const subtotal = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  // BUG propagation: if discountRate >100, discountAmount > subtotal → negative total
  const discountedSubtotal = calculateDiscount(subtotal, discountRate);
  const discountAmount = subtotal - discountedSubtotal;
  const taxAmount = discountedSubtotal * TAX_RATE;
  const total = discountedSubtotal + taxAmount;

  return { subtotal, discountAmount, taxAmount, total };
}

/**
 * Format a price as a USD currency string.
 *
 * NOTE: This is a simple implementation. A more robust version with locale
 * support exists in utils.ts as a stub awaiting implementation.
 */
export function formatPrice(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
