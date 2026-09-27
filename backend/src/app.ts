/**
 * app.ts — Express application factory (no listening), so routes and security
 * middleware can be tested without starting the server.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { JSON_BODY_LIMIT, getAllowedOrigins, isOriginAllowed } from './config';
import { missionsRouter } from './routes/missions';
import { healthRouter } from './routes/health';
import { replayRouter } from './routes/replay';

type Env = Record<string, string | undefined>;

export function createApp(env: Env = process.env): express.Express {
  const allowedOrigins = getAllowedOrigins(env);
  const app = express();
  app.disable('x-powered-by');

  // Browsers send Origin on cross-site state-changing requests. Reject unknown
  // ones server-side, since CORS alone does not stop "simple" requests from executing.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const safeMethod = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!safeMethod && origin !== undefined && !isOriginAllowed(origin, allowedOrigins)) {
      console.warn(`[security] Rejected ${req.method} ${req.path} from origin not in the allow-list`);
      res.status(403).json({ code: 'ORIGIN_NOT_ALLOWED', error: 'Request origin is not allowed' });
      return;
    }
    next();
  });
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api/health', healthRouter);
  app.use('/api/missions', missionsRouter);
  app.use('/api/replay', replayRouter);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string }).type;
    if (type === 'entity.too.large') {
      res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', error: `Request body exceeds ${JSON_BODY_LIMIT}` });
      return;
    }
    if (type === 'entity.parse.failed') {
      res.status(400).json({ code: 'INVALID_JSON', error: 'Request body is not valid JSON' });
      return;
    }
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
