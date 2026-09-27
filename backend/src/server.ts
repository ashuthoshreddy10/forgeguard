/**
 * server.ts — ForgeGuard backend entry point.
 *
 * Starts the Express + WebSocket server on FORGEGUARD_HOST (default 127.0.0.1)
 * and initialises the database.
 */

import 'dotenv/config';
import http from 'http';
import { getDatabase } from './db/database';
import { initEventBus } from './ws/EventBus';
import { createApp } from './app';
import { DEFAULT_HOST, getAllowedOrigins, getServerHost } from './config';

type Env = Record<string, string | undefined>;

export interface StartedServer {
  server: http.Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export function startServer(options: { port?: number; env?: Env } = {}): Promise<StartedServer> {
  const env = options.env ?? process.env;
  const port = options.port ?? (env['PORT'] ? parseInt(env['PORT'], 10) : 3001);
  const host = getServerHost(env);

  getDatabase(); // runs schema on first call
  const server = http.createServer(createApp(env));
  initEventBus(server, getAllowedOrigins(env));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      if (host !== DEFAULT_HOST) {
        console.warn(`[server] FORGEGUARD_HOST=${host}: listening on a non-default interface by explicit configuration`);
      }
      resolve({
        server, host, port: boundPort,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main(): Promise<void> {
  const { server, host, port } = await startServer();
  console.log(`[server] ForgeGuard backend running on http://${host}:${port}`);
  console.log(`[server] WebSocket available at ws://${host}:${port}/ws`);
  console.log(`[server] Bob provider: ${process.env['BOB_PROVIDER'] ?? 'shell'}`);

  const shutdown = (): void => {
    console.log('[server] Shutting down...');
    server.close(() => {
      const { closeDatabase } = require('./db/database') as typeof import('./db/database');
      closeDatabase();
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[server] Fatal startup error:', err);
    process.exit(1);
  });
}
