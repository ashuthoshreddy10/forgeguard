/**
 * inventory.ts — Inventory management module.
 *
 * SEEDED ISSUE #7 (Maintainability — unclear mutation):
 *   adjustStock() mutates the product object in place without returning a new value.
 *   Callers can easily miss this side-effect, especially across async boundaries.
 *
 * SEEDED ISSUE #8 (Missing test):
 *   No test covers the case where adjustStock() is called with a negative delta
 *   that would drive stock below zero. The function allows negative stock.
 */

export interface Product {
  id: string;
  name: string;
  sku: string;
  stock: number;
  reorderThreshold: number;
}

export interface StockAdjustmentResult {
  productId: string;
  previousStock: number;
  newStock: number;
  belowThreshold: boolean;
}

/**
 * Adjust the stock level of a product by the given delta (positive = add, negative = remove).
 *
 * SEEDED ISSUE: No guard against stock going below zero.
 * Also mutates the product object directly (side-effect).
 *
 * @param product - The product to adjust.
 * @param delta   - Amount to add (positive) or remove (negative).
 */
export function adjustStock(product: Product, delta: number): StockAdjustmentResult {
  const previousStock = product.stock;
  // BUG: allows negative stock — no floor at 0
  product.stock += delta;
  return {
    productId: product.id,
    previousStock,
    newStock: product.stock,
    belowThreshold: product.stock < product.reorderThreshold,
  };
}

/**
 * Find all products that are at or below their reorder threshold.
 */
export function getProductsBelowThreshold(products: Product[]): Product[] {
  return products.filter((p) => p.stock <= p.reorderThreshold);
}

/**
 * Calculate total inventory value across all products.
 *
 * @param products   - List of products.
 * @param priceMap   - Map of product ID → unit price.
 */
export function calculateInventoryValue(
  products: Product[],
  priceMap: Record<string, number>,
): number {
  return products.reduce((total, product) => {
    const price = priceMap[product.id] ?? 0;
    return total + product.stock * price;
  }, 0);
}
