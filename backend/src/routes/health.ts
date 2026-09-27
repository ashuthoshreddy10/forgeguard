/**
 * health.ts — Health check and system status routes.
 *
 * GET /api/health        — Basic liveness check
 * GET /api/health/bob    — Bob CLI availability check (non-destructive)
 */

import { Router, type Request, type Response } from 'express';
import { createBobClient } from '../bob/BobClient';
import { getEventBus } from '../ws/EventBus';

export const healthRouter = Router();

/** GET /api/health */
healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'forgeguard-backend',
    timestamp: new Date().toISOString(),
    wsConnections: (() => {
      try { return getEventBus().connectionCount; } catch { return 0; }
    })(),
  });
});

/**
 * GET /api/health/bob — Bob CLI diagnostic: resolves the launch, runs
 * `--version` and `run --help` only (no prompt is sent, no credits used).
 */
healthRouter.get('/bob', async (_req: Request, res: Response) => {
  const client = createBobClient();
  const status = await client.checkAvailability();
  res.status(status.available ? 200 : 503).json({ ...status, timestamp: new Date().toISOString() });
});
