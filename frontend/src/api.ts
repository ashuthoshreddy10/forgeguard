/**
 * api.ts — REST client. Every call resolves to either data or a structured error;
 * components never see raw exceptions.
 */

import type {
  AgentTask, ApiErrorBody, BobDiagnostics, EvidenceItem, Mission, PipelinePhase,
  ReleaseVerdictResult, ReplayAction, ReplayScenario, ReplayView, RollbackStatus, ValidationRun,
} from './types';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: ApiErrorBody };

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { ok: false, status: 0, error: { code: 'NETWORK_ERROR', error: 'The ForgeGuard backend could not be reached' } };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const err = (body && typeof body === 'object' ? body : {}) as ApiErrorBody;
  return { ok: false, status: res.status, error: { ...err, error: err.error ?? `Request failed (HTTP ${res.status})` } };
}

const post = <T>(path: string, body?: unknown): Promise<ApiResult<T>> =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const api = {
  listMissions: () => request<Mission[]>('/api/missions'),
  getMission: (id: string) => request<Mission>(`/api/missions/${id}`),
  getPhases: (id: string) => request<PipelinePhase[]>(`/api/missions/${id}/phases`),
  getTasks: (id: string) => request<AgentTask[]>(`/api/missions/${id}/tasks`),
  getEvidence: (id: string) => request<EvidenceItem[]>(`/api/missions/${id}/evidence`),
  getValidationRuns: (id: string) => request<ValidationRun[]>(`/api/missions/${id}/validation-runs`),
  getReleaseVerdict: (id: string) => request<ReleaseVerdictResult>(`/api/missions/${id}/release-verdict`),
  getRollbackStatus: (id: string) => request<RollbackStatus>(`/api/missions/${id}/rollback-status`),
  getBobHealth: () => request<BobDiagnostics>('/api/health/bob'),
  createMission: (issueText: string) => post<Mission>('/api/missions', { issueText }),
  startMission: (id: string) => post<{ message: string }>(`/api/missions/${id}/start`),
  approveMission: (id: string) => post<{ message: string }>(`/api/missions/${id}/approve`),
  rollbackMission: (id: string) => post<{ message: string; removed?: string[]; restored?: string[] }>(`/api/missions/${id}/rollback`),
  // Demo replay: separate endpoints; they never reach the mission pipeline or Bob.
  listReplayScenarios: () => request<ReplayScenario[]>('/api/replay/scenarios'),
  startReplay: (scenarioId: string) => post<ReplayView>(`/api/replay/${encodeURIComponent(scenarioId)}/start`),
  getReplay: (id: string) => request<ReplayView>(`/api/replay/${encodeURIComponent(id)}`),
  controlReplay: (id: string, action: ReplayAction, speed?: number) =>
    post<ReplayView>(`/api/replay/${encodeURIComponent(id)}/control`, speed === undefined ? { action } : { action, speed }),
  resetReplay: (id: string) => request<{ reset: true }>(`/api/replay/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
