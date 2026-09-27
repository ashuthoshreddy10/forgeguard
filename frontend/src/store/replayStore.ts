/**
 * replayStore.ts — Demo replay state, kept apart from live mission state.
 * The backend owns the replay session (clock, position, approval, rollback); this store
 * only mirrors it via the /api/replay endpoints and `replay.updated` WebSocket events.
 */

import { create } from 'zustand';
import { api } from '../api';
import type { ReplayAction, ReplayScenario, ReplayView } from '../types';

export const REPLAY_SESSION_KEY = 'forgeguard.replayId';

function remember(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(REPLAY_SESSION_KEY, id);
    else sessionStorage.removeItem(REPLAY_SESSION_KEY);
  } catch { /* storage unavailable: replay still works, it just won't survive a reload */ }
}

function remembered(): string | null {
  try { return sessionStorage.getItem(REPLAY_SESSION_KEY); } catch { return null; }
}

interface ReplayStoreState {
  scenarios: ReplayScenario[];
  scenariosLoaded: boolean;
  scenariosError: string | null;
  session: ReplayView | null;
  busy: boolean;
  /** Last refused control ({ code, error }) from the backend, e.g. APPROVAL_REQUIRED. */
  controlError: string | null;

  loadScenarios: () => Promise<void>;
  start: (scenarioId: string) => Promise<boolean>;
  control: (action: ReplayAction, speed?: number) => Promise<{ ok: boolean; error?: string }>;
  refresh: () => Promise<void>;
  rehydrate: () => Promise<boolean>;
  exit: () => Promise<void>;
  handleEvent: (replayId: string) => void;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export const useReplayStore = create<ReplayStoreState>((set, get) => ({
  scenarios: [],
  scenariosLoaded: false,
  scenariosError: null,
  session: null,
  busy: false,
  controlError: null,

  loadScenarios: async () => {
    const r = await api.listReplayScenarios();
    set(r.ok
      ? { scenarios: r.data, scenariosLoaded: true, scenariosError: null }
      : { scenariosLoaded: true, scenariosError: r.error.error ?? 'Could not load replay scenarios' });
  },

  start: async (scenarioId) => {
    set({ busy: true, controlError: null });
    const previous = get().session;
    if (previous) await api.resetReplay(previous.replayId);
    const r = await api.startReplay(scenarioId);
    set({ busy: false });
    if (!r.ok) {
      set({ controlError: `${r.error.code ?? `HTTP ${r.status}`}: ${r.error.error ?? ''}` });
      return false;
    }
    set({ session: r.data });
    remember(r.data.replayId);
    return true;
  },

  control: async (action, speed) => {
    const s = get().session;
    if (!s) return { ok: false, error: 'No replay session' };
    set({ busy: true, controlError: null });
    const r = await api.controlReplay(s.replayId, action, speed);
    set({ busy: false });
    if (r.ok) {
      set({ session: r.data });
      return { ok: true };
    }
    const error = `${r.error.code ?? `HTTP ${r.status}`}: ${r.error.error ?? ''}`;
    const latest = (r.error as { replay?: ReplayView }).replay;
    set({ controlError: error, ...(latest ? { session: latest } : {}) });
    return { ok: false, error };
  },

  refresh: async () => {
    const s = get().session;
    if (!s) return;
    const r = await api.getReplay(s.replayId);
    if (get().session?.replayId !== s.replayId) return;
    if (r.ok) set({ session: r.data });
    else if (r.status === 404) {
      remember(null);
      set({ session: null, controlError: 'The replay session no longer exists (it was reset or the server restarted).' });
    }
  },

  rehydrate: async () => {
    const id = remembered();
    if (!id) return false;
    const r = await api.getReplay(id);
    if (!r.ok) {
      remember(null);
      return false;
    }
    set({ session: r.data });
    return true;
  },

  exit: async () => {
    const s = get().session;
    if (s) await api.resetReplay(s.replayId);
    remember(null);
    set({ session: null, controlError: null });
  },

  handleEvent: (replayId) => {
    if (get().session?.replayId !== replayId) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { refreshTimer = null; void get().refresh(); }, 50);
  },
}));
