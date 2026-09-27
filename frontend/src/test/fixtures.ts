/**
 * Test fixtures shaped like real backend responses. They describe backend STATE for
 * rendering tests; none of them represents a Bob run that actually happened.
 */
import { vi } from 'vitest';
import type { AgentTask, EvidenceItem, Mission, PipelinePhase, ReleaseVerdictResult, RollbackStatus, ValidationRun } from '../types';

export const MID = '11111111-2222-3333-4444-555555555555';
const T0 = '2026-09-26T10:00:00.000Z';

export function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: MID, created_at: T0, updated_at: '2026-09-26T10:05:00.000Z', status: 'created',
    issue_text: 'Clamp discount rate to [0, 100]', repo_path: 'C:\\Users\\dev\\playground\\demo-app',
    plan_approved: 0, ...over,
  };
}

let seq = 0;
export function phase(phase_name: string, status: PipelinePhase['status'], over: Partial<PipelinePhase> = {}): PipelinePhase {
  seq += 1;
  return {
    seq, id: `phase-${phase_name}-${seq}`, mission_id: MID, phase_name, status,
    started_at: status === 'skipped' ? null : T0, completed_at: status === 'running' ? null : T0,
    error_message: null, output: null, ...over,
  };
}

export function task(task_type: string, phase_id: string, status: AgentTask['status'], over: Partial<AgentTask> = {}): AgentTask {
  seq += 1;
  return {
    seq, id: `task-${task_type}-${seq}`, phase_id, mission_id: MID, task_type, status, bob_provider: 'shell',
    bob_mode: 'ask', workspace: 'demo-app', started_at: T0, completed_at: T0, duration_ms: 1200, error_message: null, ...over,
  };
}

export function run(kind: 'baseline' | 'post', command: string, phase_id: string, exit: number | null, over: Partial<ValidationRun> = {}): ValidationRun {
  seq += 1;
  return {
    seq, id: `run-${kind}-${seq}`, mission_id: MID, phase_id, run_kind: kind, command,
    exit_code: exit, timed_out: 0, stdout: `${command} output`, stderr: '', passed: exit === 0 ? 1 : 0,
    started_at: T0, completed_at: T0, duration_ms: 4000, ...over,
  };
}

export function evidence(type: EvidenceItem['evidence_type'], phase_name: string, content: string, over: Partial<EvidenceItem> = {}): EvidenceItem {
  seq += 1;
  return { seq, id: `ev-${seq}`, mission_id: MID, task_id: null, phase_name, evidence_type: type, content, created_at: T0, ...over };
}

export const noVerdict: ReleaseVerdictResult = { verdict: null, reasons: ['No validation runs recorded: no evidence, no verdict'], commands: [], requiredCommands: [], implementationSucceeded: null };
export const noAnchor: RollbackStatus = { available: false, code: 'NO_ROLLBACK_ANCHOR', reason: 'This mission has no rollback anchor (implementation never started)', anchorRef: null };

export interface Backend {
  mission: Mission;
  phases?: PipelinePhase[];
  tasks?: AgentTask[];
  evidence?: EvidenceItem[];
  runs?: ValidationRun[];
  verdict?: ReleaseVerdictResult;
  rollback?: RollbackStatus;
  start?: { status: number; body: unknown };
}

/** Install a fetch mock that answers the ForgeGuard REST routes from `b` (mutable between calls). */
export function mockBackend(b: Backend) {
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const m = /^\/api\/missions\/([^/]+)(?:\/([a-z-]+))?$/.exec(url);
    if (url === '/api/missions' && method === 'GET') return json([b.mission]);
    if (url === '/api/health/bob') return json({ provider: 'shell', available: false, code: 'BOB_UNAVAILABLE', error: 'not found' }, 503);
    if (m) {
      const sub = m[2];
      if (method === 'POST' && sub === 'start') return json(b.start?.body ?? { message: 'Pipeline started' }, b.start?.status ?? 202);
      switch (sub) {
        case undefined: return json(b.mission);
        case 'phases': return json(b.phases ?? []);
        case 'tasks': return json(b.tasks ?? []);
        case 'evidence': return json(b.evidence ?? []);
        case 'validation-runs': return json(b.runs ?? []);
        case 'release-verdict': return json(b.verdict ?? noVerdict);
        case 'rollback-status': return json(b.rollback ?? noAnchor);
        default: break;
      }
    }
    return json({ error: 'Not found' }, 404);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}
