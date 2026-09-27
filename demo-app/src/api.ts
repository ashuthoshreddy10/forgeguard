/**
 * api.ts — Express REST API for the demo application.
 *
 * Endpoints:
 *   GET  /api/health          — Health check
 *   POST /api/orders/discount — Apply discount to an order
 *   GET  /api/products        — List all products
 *   POST /api/products/:id/stock — Adjust product stock
 *
 * SEEDED ISSUE #9 (Security / input validation):
 *   POST /api/orders/discount does NOT validate that `discountRate` is a number,
 *   or that it falls within an acceptable range. It passes it directly to
 *   applyOrderDiscount(), which passes it to the buggy calculateDiscount().
 *   Combined with the pricing.ts bug, an attacker can submit rate=9999 and
 *   receive a wildly incorrect (negative) total.
 *
 * SEEDED ISSUE #10 (Missing API documentation):
 *   No OpenAPI / JSDoc for the POST /api/products/:id/stock endpoint.
 *   The README references it but the request schema is undocumented.
 */

import express, { type Request, type Response } from 'express';
import { applyOrderDiscount, type LineItem } from './pricing.js';
import { sanitizeInput, formatCurrency } from './utils.js';
import { adjustStock, getProductsBelowThreshold, type Product } from './inventory.js';

export const app = express();
app.use(express.json());

// In-memory product store (demo purposes only — not persistent)
const products: Product[] = [
  { id: 'prod-001', name: 'Widget Alpha', sku: 'WGT-A', stock: 50, reorderThreshold: 10 },
  { id: 'prod-002', name: 'Widget Beta',  sku: 'WGT-B', stock: 8,  reorderThreshold: 10 },
  { id: 'prod-003', name: 'Gadget Pro',   sku: 'GDP-1', stock: 25, reorderThreshold: 5  },
];

/**
 * GET /api/health
 * Returns a simple health check response.
 */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/orders/discount
 *
 * Body: { items: LineItem[], discountRate: number, customerName: string }
 *
 * SEEDED ISSUE: No input validation on discountRate or items.
 * customerName is passed through sanitizeInput but sanitization is insufficient.
 */
app.post('/api/orders/discount', (req: Request, res: Response) => {
  const { items, discountRate, customerName } = req.body as {
    items: LineItem[];
    discountRate: number;
    customerName: string;
  };

  // SEEDED ISSUE: No validation — discountRate could be anything
  const sanitizedName = sanitizeInput(customerName ?? '');
  const summary = applyOrderDiscount(items ?? [], discountRate ?? 0);

  res.json({
    customer: sanitizedName,
    // SEEDED ISSUE: formatCurrency is a stub — returns empty string
    formattedTotal: formatCurrency(summary.total),
    rawTotal: summary.total,
    summary,
  });
});

/**
 * GET /api/products
 * Returns all products including those below reorder threshold.
 */
app.get('/api/products', (_req: Request, res: Response) => {
  const belowThreshold = getProductsBelowThreshold(products);
  res.json({
    products,
    alerts: belowThreshold.map((p) => ({
      productId: p.id,
      message: `${p.name} stock (${p.stock}) is at or below threshold (${p.reorderThreshold})`,
    })),
  });
});

/**
 * POST /api/products/:id/stock
 *
 * SEEDED ISSUE: No JSDoc / OpenAPI schema for this endpoint.
 * Body is implicitly { delta: number } but this is not documented anywhere.
 */
app.post('/api/products/:id/stock', (req: Request, res: Response) => {
  const product = products.find((p) => p.id === req.params['id']);
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const { delta } = req.body as { delta: number };
  const result = adjustStock(product, delta ?? 0);
  res.json(result);
});
