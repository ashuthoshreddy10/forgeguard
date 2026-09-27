/**
 * inventory.test.ts — Tests for the inventory module.
 *
 * MISSING TEST: No test for adjustStock() with negative delta driving stock below 0.
 * This gap is intentional for ForgeGuard discovery.
 */

import { describe, it, expect } from 'vitest';
import { adjustStock, getProductsBelowThreshold, calculateInventoryValue } from '../src/inventory.js';
import type { Product } from '../src/inventory.js';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p-001',
    name: 'Test Product',
    sku: 'TST-001',
    stock: 20,
    reorderThreshold: 5,
    ...overrides,
  };
}

describe('adjustStock', () => {
  it('increases stock by positive delta', () => {
    const product = makeProduct({ stock: 10 });
    const result = adjustStock(product, 5);
    expect(result.newStock).toBe(15);
    expect(result.previousStock).toBe(10);
    expect(product.stock).toBe(15); // side-effect documented
  });

  it('decreases stock by negative delta', () => {
    const product = makeProduct({ stock: 10 });
    const result = adjustStock(product, -3);
    expect(result.newStock).toBe(7);
  });

  it('flags belowThreshold when stock falls below threshold', () => {
    const product = makeProduct({ stock: 6, reorderThreshold: 5 });
    const result = adjustStock(product, -2);
    expect(result.belowThreshold).toBe(true);
  });

  it('does not flag belowThreshold when stock is above threshold', () => {
    const product = makeProduct({ stock: 20, reorderThreshold: 5 });
    const result = adjustStock(product, -1);
    expect(result.belowThreshold).toBe(false);
  });

  // MISSING TEST: adjustStock(product, -100) with stock=10 → stock = -90 (bug)
  // ForgeGuard TestEngineer should recommend testing negative stock prevention.
});

describe('getProductsBelowThreshold', () => {
  it('returns products at or below threshold', () => {
    const products: Product[] = [
      makeProduct({ id: 'p-1', stock: 5, reorderThreshold: 5 }),
      makeProduct({ id: 'p-2', stock: 4, reorderThreshold: 5 }),
      makeProduct({ id: 'p-3', stock: 20, reorderThreshold: 5 }),
    ];
    const result = getProductsBelowThreshold(products);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.id)).toContain('p-1');
    expect(result.map((p) => p.id)).toContain('p-2');
  });

  it('returns empty array when all products are above threshold', () => {
    const products = [makeProduct({ stock: 100, reorderThreshold: 5 })];
    expect(getProductsBelowThreshold(products)).toHaveLength(0);
  });
});

describe('calculateInventoryValue', () => {
  it('calculates total value correctly', () => {
    const products: Product[] = [
      makeProduct({ id: 'p-1', stock: 10 }),
      makeProduct({ id: 'p-2', stock: 5 }),
    ];
    const priceMap = { 'p-1': 20, 'p-2': 50 };
    const value = calculateInventoryValue(products, priceMap);
    expect(value).toBe(10 * 20 + 5 * 50); // 200 + 250 = 450
  });

  it('uses 0 price for products not in priceMap', () => {
    const products = [makeProduct({ id: 'p-unknown', stock: 10 })];
    const value = calculateInventoryValue(products, {});
    expect(value).toBe(0);
  });
});
