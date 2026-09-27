/**
 * EventBus.ts — WebSocket broadcast infrastructure.
 *
 * Manages WebSocket connections and broadcasts typed ForgeGuard events
 * to all connected clients. Supports per-mission subscriptions so clients
 * only receive events for missions they are watching.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import type { ForgeGuardEvent } from './events';
import { getAllowedOrigins, isOriginAllowed } from '../config';

/**
 * Origin policy for WebSocket upgrades. Browsers always send Origin on a WebSocket
 * handshake, so a website can only connect if its origin is allow-listed. A missing
 * Origin means a non-browser client (local tooling, test harnesses); those can forge
 * any header anyway, and the loopback bind (FORGEGUARD_HOST) is the control for them.
 */
export function isWebSocketOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (origin === undefined) return true;
  return isOriginAllowed(origin, allowedOrigins);
}

interface ConnectedClient {
  ws: WebSocket;
  /** If set, only events for this mission are forwarded to this client. */
  missionId?: string;
}

export class EventBus {
  private wss: WebSocketServer;
  private clients: Set<ConnectedClient> = new Set();

  constructor(server: Server, allowedOrigins: string[] = getAllowedOrigins()) {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      verifyClient: (info: { origin?: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
        const origin = info.req.headers.origin;
        if (isWebSocketOriginAllowed(origin, allowedOrigins)) {
          done(true);
          return;
        }
        console.warn('[ws] Rejected WebSocket connection from an origin not in the allow-list');
        done(false, 403, 'Origin not allowed');
      },
    });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });
    console.log('[ws] WebSocket server listening on /ws');
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Parse optional missionId from query string: /ws?missionId=<id>
    const url = new URL(req.url ?? '', 'http://localhost');
    const missionIdParam = url.searchParams.get('missionId');

    const client: ConnectedClient = { ws };
    if (missionIdParam) client.missionId = missionIdParam;
    this.clients.add(client);

    console.log(`[ws] Client connected${missionIdParam ? ` (mission: ${missionIdParam})` : ''}`);

    ws.on('close', () => {
      this.clients.delete(client);
      console.log('[ws] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[ws] Client error:', err.message);
      this.clients.delete(client);
    });

    // Send a welcome message so the client knows the connection is alive
    this.sendToClient(client, {
      type: 'system.error', // using system.error as a channel for connection ack
      timestamp: new Date().toISOString(),
      missionId: missionIdParam ?? '',
      payload: { error: '' }, // empty error = connected successfully
    } as ForgeGuardEvent);
  }

  /**
   * Broadcast an event to all clients subscribed to the event's mission.
   */
  broadcast(event: ForgeGuardEvent): void {
    for (const client of this.clients) {
      // Send if client has no filter, or filter matches event mission
      if (!client.missionId || client.missionId === event.missionId) {
        this.sendToClient(client, event);
      }
    }
  }

  private sendToClient(client: ConnectedClient, event: ForgeGuardEvent): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      try {
        client.ws.send(JSON.stringify(event));
      } catch (err) {
        console.error('[ws] Failed to send event:', err);
      }
    }
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.clients.size;
  }
}

// Singleton instance (set after HTTP server is created)
let _eventBus: EventBus | null = null;

export function initEventBus(server: Server, allowedOrigins?: string[]): EventBus {
  _eventBus = new EventBus(server, allowedOrigins);
  return _eventBus;
}

export function getEventBus(): EventBus {
  if (!_eventBus) throw new Error('EventBus not initialised. Call initEventBus(server) first.');
  return _eventBus;
}

/**
 * Broadcast if the EventBus is running; a no-op otherwise (e.g. in unit tests).
 * Delivery failures never affect pipeline state.
 */
export function emitEvent(event: ForgeGuardEvent): void {
  if (!_eventBus) return;
  try {
    _eventBus.broadcast(event);
  } catch (err) {
    console.error('[ws] broadcast failed:', err);
  }
}
