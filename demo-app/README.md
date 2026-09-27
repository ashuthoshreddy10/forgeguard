# Demo Application

A small Node.js + TypeScript application used as the **target codebase** for ForgeGuard analysis.

## Overview

This application simulates a simple e-commerce back-end with pricing, inventory, and
a REST API. It is **intentionally designed** with realistic engineering problems so that
ForgeGuard's analysis pipeline has meaningful material to work with.

## Modules

| Module | Description |
|---|---|
| `src/pricing.ts` | Discount calculation and order summary |
| `src/utils.ts` | General utilities: formatting, sanitization, ID generation |
| `src/inventory.ts` | Stock management and inventory value calculation |
| `src/api.ts` | Express REST API exposing the above modules |
| `src/server.ts` | Entry point — starts the HTTP server |

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/orders/discount` | Apply discount rate to an order |
| `GET` | `/api/products` | List products with reorder alerts |
| `POST` | `/api/products/:id/stock` | Adjust product stock level |

### POST /api/orders/discount

**Request body:**
```json
{
  "items": [
    { "name": "Widget", "quantity": 2, "unitPrice": 10.00 },
    { "name": "Gadget", "quantity": 1, "unitPrice": 30.00 }
  ],
  "discountRate": 10,
  "customerName": "Alice"
}
```

### POST /api/products/:id/stock

**Request body:** `{ "delta": number }`  
Positive delta adds stock. Negative delta removes stock.

> ⚠️ **Note:** The `delta` parameter is not validated and can drive stock negative.
> This is a seeded engineering issue — see the [Seeded Issues](#seeded-issues) section below.

## Running the Application

```bash
npm install
npm run dev      # Start development server on port 3100
npm test         # Run test suite
npm run typecheck
npm run lint
```

## Seeded Engineering Issues

This application contains **10 intentionally seeded issues** for ForgeGuard to discover
and remediate. They are documented here for transparency.

| # | Location | Type | Description |
|---|---|---|---|
| 1 | `pricing.ts` | **Bug** | `calculateDiscount()` does not clamp `discountRate` to [0, 100]. Rates >100 produce negative prices. |
| 2 | `pricing.test.ts` | **Missing test** | No boundary test for `discountRate > 100` or `< 0`. |
| 3 | `pricing.ts` + `utils.ts` | **Maintainability** | `TAX_RATE` / `SALES_TAX` are duplicated constants. Should come from a shared config. |
| 4 | `utils.ts` | **Stub / missing feature** | `formatCurrency()` returns an empty string. Callers in `api.ts` depend on it. |
| 5 | `utils.ts` | **Security gap** | `sanitizeInput()` only trims whitespace — does not strip HTML or script tags. |
| 6 | Same as #3 | (See above) | |
| 7 | `inventory.ts` | **Maintainability** | `adjustStock()` mutates the product object in place without returning a copy. |
| 8 | `inventory.test.ts` | **Missing test** | No test for negative delta driving stock below zero. |
| 9 | `api.ts` | **Security / validation** | `POST /api/orders/discount` passes `discountRate` to `applyOrderDiscount()` without any type or range validation. |
| 10 | `api.ts` | **Missing documentation** | `POST /api/products/:id/stock` request schema is undocumented. |

These issues are designed to exercise all five ForgeGuard specialist analysis types:
- **Code Impact**: issues #1, #4, #7
- **Test Engineering**: issues #2, #8
- **Security**: issues #5, #9
- **API/Compatibility**: issue #10
- **Documentation**: issue #10, and any README gaps
