/**
 * display.tsx — Rendering context shared by the mission panels. The same panels render
 * live missions and demo replays; in replay they label fixture data and show replay
 * time ("T+5s") instead of wall-clock timestamps.
 */

import React, { createContext, useContext } from 'react';
import { formatTime } from './selectors';

export interface DisplayMode {
  replay: boolean;
  formatTime: (iso: string | null | undefined) => string;
}

/** Replay timestamps are offsets from the Unix epoch; show them as replay time. */
export function formatReplayTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = ms / 1000;
  return `T+${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

const LIVE: DisplayMode = { replay: false, formatTime };
export const REPLAY_DISPLAY: DisplayMode = { replay: true, formatTime: formatReplayTime };

const DisplayContext = createContext<DisplayMode>(LIVE);

export function DisplayProvider({ mode, children }: { mode: DisplayMode; children: React.ReactNode }): React.ReactElement {
  return <DisplayContext.Provider value={mode}>{children}</DisplayContext.Provider>;
}

export function useDisplay(): DisplayMode {
  return useContext(DisplayContext);
}
