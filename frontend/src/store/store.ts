/**
 * store.ts — Zustand store for the ForgeGuard control center.
 *
 * REST is the source of truth: every panel renders data fetched from the backend.
 * WebSocket events never patch UI state directly; they schedule a (debounced) re-fetch,
 * so duplicated, reordered or missed events cannot corrupt what is shown. The only data
 * taken from WebSocket alone is live Bob output (`agent.output`), which is not persisted.
 */

import { create } from 'zustand';
import { api, type ApiResult } from '../api';
import { useReplayStore } from './replayStore';
import type {
  AgentTask, BobDiagnostics, EvidenceItem, ForgeGuardEvent, Mission, PipelinePhase,
  ReleaseVerdictResult, RollbackOutcome, RollbackStatus, StartOutcome, ValidationRun,
} from '../types';

export interface Loadable<T> {
  data: T;
  loading: boolean;
  /** Set when the last fetch failed; previous data is kept. */
  error: string | null;
  loaded: boolean;
}

const loadable = <T>(data: T): Loadable<T> => ({ data, loading: false, error: null, loaded: false });

export interface MissionDetail {
  missionId: string | null;
  mission: Loadable<Mission | null>;
  phases: Loadable<PipelinePhase[]>;
  tasks: Loadable<AgentTask[]>;
  evidence: Loadable<EvidenceItem[]>;
  validationRuns: Loadable<ValidationRun[]>;
  verdict: Loadable<ReleaseVerdictResult | null>;
  rollback: Loadable<RollbackStatus | null>;
}

const emptyDetail = (missionId: string | null): MissionDetail => ({
  missionId,
  mission: loadable(null),
  phases: loadable([]),
  tasks: loadable([]),
  evidence: loadable([]),
  validationRuns: loadable([]),
  verdict: loadable(null),
  rollback: loadable(null),
});

export interface LiveOutput {
  taskId: string;
  taskType: string;
  text: string;
}

interface ForgeGuardState {
  /** Live missions or the demo replay workspace. */
  view: 'live' | 'replay';
  missions: Loadable<Mission[]>;
  activeMissionId: string | null;
  detail: MissionDetail;
  startOutcomes: Record<string, StartOutcome>;
  rollbackOutcomes: Record<string, RollbackOutcome>;
  liveOutput: LiveOutput[];
  bobHealth: Loadable<BobDiagnostics | null>;
  wsConnected: boolean;
  /** Number of times the WebSocket reconnected after a drop (each triggers a REST rehydrate). */
  wsReconnects: number;
  isEvidenceDrawerOpen: boolean;
  busy: { starting: boolean; approving: boolean; rollingBack: boolean };

  loadMissions: () => Promise<void>;
  selectMission: (id: string | null) => void;
  refreshActive: () => Promise<void>;
  scheduleRefresh: () => void;
  loadBobHealth: () => Promise<void>;
  createMission: (issueText: string) => Promise<ApiResult<Mission>>;
  startMission: (id: string) => Promise<void>;
  approveMission: (id: string) => Promise<ApiResult<{ message: string }>>;
  rollbackMission: (id: string) => Promise<void>;
  setEvidenceDrawerOpen: (open: boolean) => void;
  setView: (view: 'live' | 'replay') => void;
  setWsConnected: (connected: boolean) => void;
  handleWsEvent: (event: ForgeGuardEvent) => void;
}

const errorText = (r: { error: { code?: string; error?: string } }): string =>
  r.error.code ? `${r.error.code}: ${r.error.error ?? ''}` : r.error.error ?? 'Request failed';

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let wsEverConnected = false;
export const REFRESH_DEBOUNCE_MS = 250;

export const useStore = create<ForgeGuardState>((set, get) => {
  /** Apply a fetch result to one resource, but only if the mission is still the active one. */
  function apply<K extends Exclude<keyof MissionDetail, 'missionId'>>(
    missionId: string, key: K, result: ApiResult<MissionDetail[K]['data']>,
  ): void {
    set((s) => {
      if (s.detail.missionId !== missionId) return s;
      const prev = s.detail[key];
      const next = result.ok
        ? { data: result.data, loading: false, error: null, loaded: true }
        : { data: prev.data, loading: false, error: errorText(result), loaded: prev.loaded };
      return { detail: { ...s.detail, [key]: next } };
    });
  }

  function markLoading(missionId: string): void {
    set((s) => {
      if (s.detail.missionId !== missionId) return s;
      const d = { ...s.detail };
      for (const key of ['mission', 'phases', 'tasks', 'evidence', 'validationRuns', 'verdict', 'rollback'] as const) {
        d[key] = { ...d[key], loading: true } as never;
      }
      return { detail: d };
    });
  }

  return {
    view: 'live',
    missions: loadable([]),
    activeMissionId: null,
    detail: emptyDetail(null),
    startOutcomes: {},
    rollbackOutcomes: {},
    liveOutput: [],
    bobHealth: loadable(null),
    wsConnected: false,
    wsReconnects: 0,
    isEvidenceDrawerOpen: false,
    busy: { starting: false, approving: false, rollingBack: false },

    loadMissions: async () => {
      set((s) => ({ missions: { ...s.missions, loading: true } }));
      const r = await api.listMissions();
      set((s) => ({
        missions: r.ok
          ? { data: Array.isArray(r.data) ? r.data : [], loading: false, error: null, loaded: true }
          : { ...s.missions, loading: false, error: errorText(r) },
      }));
    },

    selectMission: (id) => {
      set({ view: 'live', activeMissionId: id, detail: emptyDetail(id), liveOutput: [], isEvidenceDrawerOpen: false });
      if (id) void get().refreshActive();
    },

    refreshActive: async () => {
      const id = get().activeMissionId;
      if (!id) return;
      markLoading(id);
      await Promise.all([
        api.getMission(id).then((r) => apply(id, 'mission', r)),
        api.getPhases(id).then((r) => apply(id, 'phases', r)),
        api.getTasks(id).then((r) => apply(id, 'tasks', r)),
        api.getEvidence(id).then((r) => apply(id, 'evidence', r)),
        api.getValidationRuns(id).then((r) => apply(id, 'validationRuns', r)),
        api.getReleaseVerdict(id).then((r) => apply(id, 'verdict', r)),
        api.getRollbackStatus(id).then((r) => apply(id, 'rollback', r)),
      ]);
    },

    scheduleRefresh: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void get().refreshActive();
        void get().loadMissions();
      }, REFRESH_DEBOUNCE_MS);
    },

    loadBobHealth: async () => {
      set((s) => ({ bobHealth: { ...s.bobHealth, loading: true } }));
      const r = await api.getBobHealth();
      // 503 carries the diagnostic body too: unavailable is data, not a fetch failure.
      const body = r.ok ? r.data : r.status === 503 ? (r.error as BobDiagnostics) : null;
      set({
        bobHealth: body
          ? { data: body, loading: false, error: null, loaded: true }
          : { data: null, loading: false, error: r.ok ? null : errorText(r), loaded: true },
      });
    },

    createMission: async (issueText) => {
      const r = await api.createMission(issueText);
      if (r.ok) {
        await get().loadMissions();
        get().selectMission(r.data.id);
      }
      return r;
    },

    startMission: async (id) => {
      set((s) => ({ busy: { ...s.busy, starting: true } }));
      const r = await api.startMission(id);
      const outcome: StartOutcome = r.ok
        ? { httpStatus: r.status, at: new Date().toISOString() }
        : {
            httpStatus: r.status,
            ...(r.error.code ? { code: r.error.code } : {}),
            ...(r.error.error ? { error: r.error.error } : {}),
            ...(r.error['diagnostics'] ? { diagnostics: r.error['diagnostics'] as BobDiagnostics } : {}),
            at: new Date().toISOString(),
          };
      set((s) => ({ startOutcomes: { ...s.startOutcomes, [id]: outcome }, busy: { ...s.busy, starting: false } }));
      await Promise.all([get().refreshActive(), get().loadMissions()]);
    },

    approveMission: async (id) => {
      set((s) => ({ busy: { ...s.busy, approving: true } }));
      const r = await api.approveMission(id);
      set((s) => ({ busy: { ...s.busy, approving: false } }));
      await get().refreshActive();
      return r;
    },

    rollbackMission: async (id) => {
      set((s) => ({ busy: { ...s.busy, rollingBack: true } }));
      const r = await api.rollbackMission(id);
      const outcome: RollbackOutcome = r.ok
        ? { ok: true, httpStatus: r.status, removed: r.data.removed ?? [], restored: r.data.restored ?? [], at: new Date().toISOString() }
        : {
            ok: false, httpStatus: r.status,
            ...(r.error.code ? { code: r.error.code } : {}),
            ...(r.error.error ? { error: r.error.error } : {}),
            at: new Date().toISOString(),
          };
      set((s) => ({ rollbackOutcomes: { ...s.rollbackOutcomes, [id]: outcome }, busy: { ...s.busy, rollingBack: false } }));
      await Promise.all([get().refreshActive(), get().loadMissions()]);
    },

    setEvidenceDrawerOpen: (open) => set({ isEvidenceDrawerOpen: open }),

    setView: (view) => set({ view, isEvidenceDrawerOpen: false }),

    setWsConnected: (connected) => {
      const was = get().wsConnected;
      if (connected && !was) {
        // Every (re)connect rehydrates from REST: events missed while disconnected are not replayed.
        const isReconnect = wsEverConnected;
        wsEverConnected = true;
        set((s) => ({ wsConnected: true, wsReconnects: isReconnect ? s.wsReconnects + 1 : s.wsReconnects }));
        void get().loadMissions();
        void get().refreshActive();
        return;
      }
      if (connected !== was) set({ wsConnected: connected });
    },

    handleWsEvent: (event) => {
      const { activeMissionId } = get();
      if (event.type === 'system.error' && !(event.payload as { error?: string }).error) return; // connection ack
      if (event.type.startsWith('replay.')) {
        // Replay notifications never refresh live mission state.
        const replayId = (event.payload as { replayId?: string }).replayId;
        if (replayId) useReplayStore.getState().handleEvent(replayId);
        return;
      }

      if (event.type === 'agent.started' && event.missionId === activeMissionId) {
        const p = event.payload as { taskId?: string; taskType?: string };
        if (p.taskId && !get().liveOutput.some((o) => o.taskId === p.taskId)) {
          set((s) => ({ liveOutput: [...s.liveOutput, { taskId: p.taskId!, taskType: p.taskType ?? 'agent', text: '' }] }));
        }
      }
      if (event.type === 'agent.output') {
        if (event.missionId !== activeMissionId) return;
        const p = event.payload as { taskId?: string; taskType?: string; chunk?: string };
        if (!p.taskId || !p.chunk) return;
        set((s) => {
          const exists = s.liveOutput.some((o) => o.taskId === p.taskId);
          const liveOutput = exists
            ? s.liveOutput.map((o) => (o.taskId === p.taskId ? { ...o, text: o.text + p.chunk } : o))
            : [...s.liveOutput, { taskId: p.taskId!, taskType: p.taskType ?? 'agent', text: p.chunk! }];
          return { liveOutput };
        });
        return;
      }
      if (!activeMissionId || event.missionId === activeMissionId || event.type.startsWith('mission.')) {
        get().scheduleRefresh();
      }
    },
  };
});
