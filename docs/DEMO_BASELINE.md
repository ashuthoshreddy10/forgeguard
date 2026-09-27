# Demo-App Baseline

The demo-app is the target repository that ForgeGuard analyses and changes. This document records its **pre-Bob starting state**. Any later implementation, and any rollback, is measured against this state.

## Repository

| | |
|---|---|
| Path | `%USERPROFILE%\.bob\playground\demo-app` |
| Git | independent repository (own `.git`), branch `main` |
| Baseline commit | **`fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f`** (`fc6794e`) |
| Commit message | `Baseline: demo-app with seeded engineering issues (pre-ForgeGuard state)` |
| Author | SANTHI P (the machine's configured git identity) |
| `git status` after commit | clean (`nothing to commit, working tree clean`) |

The parent `playground` directory was **not** a Git repository when the baseline was made. The demo-app repository contains only the demo-app.

### Packaging in the ForgeGuard repository

In the published ForgeGuard repository (https://github.com/ashuthoshreddy10/forgeguard), `demo-app/` is a **normal tracked directory**, not a submodule, and a plain `git clone` includes it.

- **History:** the original history was imported, not squashed. Commit `fc6794e…` itself (same SHA, tree `54738f4b…`) is the second parent of the import merge commit in the root history, and the tag `demo-app-baseline` points at it.
- **Setup:** `node scripts/setup-demo-repo.mjs` re-creates `demo-app/.git` at exactly `fc6794e`. ForgeGuard needs this for live missions (demo-app must be the top level of its own repository) and for the backend tests.
- **No nested `.git` is tracked.**

## What the baseline commit contains (16 files)

```
.gitignore  README.md  eslint.config.js  package.json  package-lock.json
tsconfig.json  tsconfig.build.json  vitest.config.ts
src/api.ts  src/inventory.ts  src/pricing.ts  src/server.ts  src/utils.ts
tests/inventory.test.ts  tests/pricing.test.ts  tests/utils.test.ts
```

## Files deliberately excluded from git (`demo-app/.gitignore`)

| Excluded | Why |
|---|---|
| `node_modules/` | installed dependencies (restore with `npm ci`) |
| `dist/`, `*.tsbuildinfo` | build output |
| `coverage/`, `.nyc_output/` | test coverage output |
| `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key` | secrets. The demo-app has none today; this protects against adding one later |
| `*.log`, `npm-debug.log*` | logs |
| `.DS_Store`, `Thumbs.db`, `.vscode/`, `.idea/` | OS and editor files |

No secrets were committed. The staged file list above was reviewed before committing.

Twelve stale compiler artifacts were **deleted, not committed**: `tests/*.test.js`, `*.js.map`, `*.d.ts` and `*.d.ts.map`. They had been emitted next to the test sources by the earlier failing `tsc` build (the TS6059 `rootDir` problem), and they were also what broke `npm run lint`.

## Tooling fixes in the baseline (configuration only)

| Problem (audit §2) | Fix |
|---|---|
| TS6059: `tests/*.ts` outside `rootDir: ./src` broke `typecheck` and `build` | `tsconfig.json` is now the type-check config: it covers `src` and `tests`, sets `noEmit: true`, and keeps every strictness flag. The new `tsconfig.build.json` extends it with `rootDir: ./src`, `outDir: ./dist`, declarations and source maps, and `include: src/**/*`. The `build` script is now `tsc -p tsconfig.build.json`. |
| ESLint `no-undef` on `process` and `console` (no Node globals) | `eslint.config.js` applies typescript-eslint's own `eslint-recommended` override for `.ts` files. It turns off core rules the TypeScript compiler already enforces, such as `no-undef`. Node globals are declared by `@types/node` and checked by `tsc`. It also turns on `no-var`, `prefer-const`, `prefer-rest-params` and `prefer-spread`. `dist/` and `coverage/` are ignored. No rule was weakened beyond that documented override, and no dependency was added. |
| `dev` script used `ts-node-esm`, which isn't installed | `dev` is now `npm run build && node dist/server.js`. No new dependency. Verified: the server starts and `GET /api/health` returns `{"status":"ok"}`. |

Not changed:

- compiler strictness (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`)
- any test file's content
- any `src/` file

## Validation commands

This is ForgeGuard's validation policy (`REQUIRED_VALIDATION_COMMANDS`):

```
npm run lint
npm test
npm run typecheck
npm run build
```

## Baseline results (run on the committed state, 2026-09-26)

| Command | Exit | Duration | Result |
|---|---|---|---|
| `npm run lint` | 0 | 7.6 s | no errors, no warnings |
| `npm test` | 0 | 4.5 s | 3 files, **29 / 29 passed** (pricing 8, inventory 8, utils 13) |
| `npm run typecheck` | 0 | 4.6 s | clean |
| `npm run build` | 0 | 4.1 s | `dist/` emitted (5 modules plus `.d.ts` and maps) |

`git status` stayed clean after the build, because `dist/` is ignored.

The same four commands were also run **through ForgeGuard's real validation executor**, which persists rows to `validation_runs` (`backend: npm run test:integration`). All 8 rows (4 baseline and 4 post) had exit code 0, with real stdout (`29 passed`), durations and timestamps. The verdict was `ready`.

Before the fixes, the same commands gave:

| Command | Exit | Result |
|---|---|---|
| `typecheck` | 2 | TS6059 ×3 |
| `lint` | 1 | 6 errors |
| `test` | 0 | 29/29 passed |
| `build` | 2 | TS6059 ×3 |

## Intentionally seeded issues that remain

All ten issues from `demo-app/README.md` are untouched. The runtime ones were checked against the running dev server:

| # | Issue | Still present (evidence) |
|---|---|---|
| 1 | `calculateDiscount()` doesn't clamp the rate | `POST /api/orders/discount` with `discountRate: 150` on a 100.00 order gives `total: -54` |
| 2 | No boundary test for rate > 100 or < 0 | `pricing.test.ts` is unchanged, with the `MISSING TEST` comments |
| 3 / 6 | `TAX_RATE` / `SALES_TAX` duplicated | both constants are still defined, in `pricing.ts` and `utils.ts` |
| 4 | `formatCurrency()` is a stub | the response has `formattedTotal: ""` |
| 5 | `sanitizeInput()` only trims | `customerName: "<script>x</script>"` is echoed back unchanged |
| 7 | `adjustStock()` mutates in place | the code is unchanged; the test still asserts the side effect |
| 8 | No test for negative stock | `POST /api/products/prod-002/stock` with `{"delta":-100}` gives `newStock: -92` |
| 9 | No validation of `discountRate` in the API | see #1 |
| 10 | Stock endpoint schema undocumented | `api.ts` is unchanged |

The green baseline is expected. The seeded issues are logic, security and coverage gaps that the existing happy-path tests don't exercise. They are there for ForgeGuard's analysis to find, not for the toolchain to trip over.
