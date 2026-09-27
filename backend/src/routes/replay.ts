/**
 * replay.ts — Deterministic demo replay API (docs/DEMO_REPLAY.md).
 * Never invokes Bob, the mission orchestrator, validation commands or git.
 *
 * GET    /api/replay/scenarios          — available scenarios
 * POST   /api/replay/:scenario/start    — start a replay session (plays automatically)
 * GET    /api/replay/:id                — current replay state
 * POST   /api/replay/:id/control        — { action: play|pause|restart|next|approve|rollback|speed, speed? }
 * DELETE /api/replay/:id                — reset: the session and its state disappear
 */

import { Router, type Request, type Response } from 'express';
import { controlReplay, getReplay, listScenarios, resetReplay, startReplay } from '../replay/ReplayStore';

export const replayRouter = Router();

replayRouter.get('/scenarios', (_req: Request, res: Response) => {
  res.json(listScenarios());
});

replayRouter.post('/:scenario/start', (req: Request, res: Response) => {
  const r = startReplay(req.params['scenario'] ?? '');
  res.status(r.httpStatus).json(r.body);
});

replayRouter.get('/:id', (req: Request, res: Response) => {
  const r = getReplay(req.params['id'] ?? '');
  res.status(r.httpStatus).json(r.body);
});

replayRouter.post('/:id/control', (req: Request, res: Response) => {
  const { action, speed } = (req.body ?? {}) as { action?: unknown; speed?: unknown };
  const r = controlReplay(req.params['id'] ?? '', typeof action === 'string' ? action : '', speed);
  res.status(r.httpStatus).json(r.body);
});

replayRouter.delete('/:id', (req: Request, res: Response) => {
  const r = resetReplay(req.params['id'] ?? '');
  res.status(r.httpStatus).json(r.body);
});
