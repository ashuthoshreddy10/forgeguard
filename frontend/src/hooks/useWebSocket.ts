/**
 * useWebSocket.ts — One WebSocket to the backend, with automatic reconnect.
 *
 * Events are handed to the store, which only schedules REST re-fetches. Every
 * (re)connect triggers a full REST rehydrate (see store.setWsConnected), so state
 * that changed while disconnected — including terminal mission states — is picked up.
 */

import { useEffect } from 'react';
import { useStore } from '../store/store';
import type { ForgeGuardEvent } from '../types';

const RECONNECT_DELAY_MS = 3000;

export function useWebSocket(): void {
  const setWsConnected = useStore((s) => s.setWsConnected);
  const handleWsEvent = useStore((s) => s.handleWsEvent);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    function connect(): void {
      ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`);
      ws.onopen = () => setWsConnected(true);
      ws.onmessage = (evt) => {
        try {
          handleWsEvent(JSON.parse(evt.data as string) as ForgeGuardEvent);
        } catch {
          // ignore unparseable messages
        }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (!disposed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      };
      ws.onerror = () => ws?.close();
    }

    connect();
    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [setWsConnected, handleWsEvent]);
}
