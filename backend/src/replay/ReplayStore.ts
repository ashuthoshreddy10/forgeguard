/**
 * ReplayStore.ts — In-memory replay sessions: playback clock, controls, reset.
 *
 * Sessions live only in this process's memory (never in the mission database) and
 * disappear on reset or server restart. Each session's view is recomputed from
 * (fixture, position, approved, rolledBack) by ReplayEngine, so it is deterministic.
 * The only side effect is a `replay.updated` WebSocket notification.
 */

import { emitEvent } from '../ws/EventBus';
import { approvalGateIndex, buildReplayView, validateFixture, type ReplayView } from './ReplayEngine';
import type { ReplayFixture, ReplayScenarioSummary, ReplaySpeed, ReplayState, ReplayStatus } from './ReplayTypes';
import safeFix from './fixtures/safe-fix.json';
import regressionBlocked from './fixtures/regression-blocked.json';
import bobDisagreement from './fixtures/bob-disagreement.json';

/** Minimum wall-clock time per step at 1x, so steps sharing a replay second are still visible. */
export const STEP_MIN_MS = 600;
export const MAX_SESSIONS = 10;
export const REPLAY_SPEEDS: ReplaySpeed[] = [1, 2, 4];
export const REPLAY_ACTIONS = ['play', 'pause', 'restart', 'next', 'approve', 'rollback', 'speed'] as const;
export type ReplayControl = (typeof REPLAY_ACTIONS)[number];

function loadFixtures(list: unknown[]): Map<string, ReplayFixture> {
  const map = new Map<string, ReplayFixture>();
  for (const raw of list) {
    const f = raw as ReplayFixture;
    const problems = validateFixture(f);
    if (problems.length > 0) throw new Error(`Invalid replay fixture ${f.id}: ${problems.join('; ')}`);
    map.set(f.id, f);
  }
  return map;
}

/** Fixed registry: scenario ids are never turned into file paths. */
export const FIXTURES = loadFixtures([safeFix, regressionBlocked, bobDisagreement]);

interface Session {
  id: string;
  fixture: ReplayFixture;
  state: ReplayState;
  status: ReplayStatus;
  speed: ReplaySpeed;
  timer: NodeJS.Timeout | null;
}

export type ReplaySessionView = ReplayView & { replayId: string; status: ReplayStatus; speed: ReplaySpeed };

const sessions = new Map<string, Session>();
let counter = 0;

export interface ReplayResult { httpStatus: number; body: object }

export function listScenarios(): ReplayScenarioSummary[] {
  return [...FIXTURES.values()].map((f) => ({
    id: f.id, title: f.title, purpose: f.purpose, expectedFinalState: f.expectedFinalState,
    steps: f.timeline.length, durationSeconds: f.timeline.at(-1)?.t ?? 0,
  }));
}

function view(s: Session): ReplaySessionView {
  return { ...buildReplayView(s.fixture, s.state), replayId: s.id, status: s.status, speed: s.speed };
}

function notify(s: Session): void {
  const v = buildReplayView(s.fixture, s.state);
  emitEvent({
    type: 'replay.updated', timestamp: new Date().toISOString(), missionId: v.mission.id,
    payload: { replayId: s.id, position: v.position, status: s.status },
  });
}

function stopTimer(s: Session): void {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
}

const lastIndex = (s: Session): number => s.fixture.timeline.length - 1;
const atGate = (s: Session): boolean => s.state.position === approvalGateIndex(s.fixture) && !s.state.approved;

/** Recompute the status after the position changed; playback stops at the gate and at the end. */
function settle(s: Session, keepPlaying: boolean): void {
  if (s.state.position >= lastIndex(s)) s.status = 'finished';
  else if (atGate(s)) s.status = 'awaiting_approval';
  else s.status = keepPlaying ? 'playing' : 'paused';
  if (s.status === 'playing') schedule(s);
  else stopTimer(s);
}

function schedule(s: Session): void {
  stopTimer(s);
  const steps = s.fixture.timeline;
  const here = steps[s.state.position]!;
  const next = steps[s.state.position + 1];
  if (!next) return;
  const delay = Math.max((next.t - here.t) * 1000, STEP_MIN_MS) / s.speed;
  s.timer = setTimeout(() => {
    s.timer = null;
    if (!sessions.has(s.id) || s.status !== 'playing') return;
    s.state = { ...s.state, position: s.state.position + 1 };
    settle(s, true);
    notify(s);
  }, delay);
  s.timer.unref?.();
}

export function startReplay(scenarioId: string): ReplayResult {
  const fixture = Object.prototype.hasOwnProperty.call(Object.fromEntries(FIXTURES), scenarioId) ? FIXTURES.get(scenarioId) : undefined;
  if (!fixture) return { httpStatus: 404, body: { code: 'REPLAY_SCENARIO_NOT_FOUND', error: 'Unknown replay scenario' } };
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string;
    resetReplay(oldest);
  }
  const s: Session = {
    id: `replay-session-${String(++counter).padStart(3, '0')}`,
    fixture, state: { position: 0, approved: false, rolledBack: false }, status: 'playing', speed: 1, timer: null,
  };
  sessions.set(s.id, s);
  settle(s, true);
  notify(s);
  return { httpStatus: 201, body: view(s) };
}

export function getReplay(id: string): ReplayResult {
  const s = sessions.get(id);
  return s ? { httpStatus: 200, body: view(s) } : { httpStatus: 404, body: { code: 'REPLAY_NOT_FOUND', error: 'Replay session not found (it may have been reset)' } };
}

export function controlReplay(id: string, action: string, speed?: unknown): ReplayResult {
  const s = sessions.get(id);
  if (!s) return getReplay(id);
  const conflict = (code: string, error: string): ReplayResult => ({ httpStatus: 409, body: { code, error, replay: view(s) } });

  switch (action) {
    case 'play':
      if (s.status === 'paused') settle(s, true);
      break;
    case 'pause':
      if (s.status === 'playing') { stopTimer(s); s.status = 'paused'; }
      break;
    case 'restart':
      stopTimer(s);
      s.state = { position: 0, approved: false, rolledBack: false };
      settle(s, true);
      break;
    case 'next':
      if (s.status === 'finished') return conflict('REPLAY_FINISHED', 'The replay has reached its last step');
      if (atGate(s)) return conflict('APPROVAL_REQUIRED', 'Approve the change plan to continue');
      stopTimer(s);
      s.state = { ...s.state, position: s.state.position + 1 };
      settle(s, s.status === 'playing');
      break;
    case 'approve':
      if (!atGate(s)) return conflict('NOT_AWAITING_APPROVAL', 'The replay is not waiting for approval');
      s.state = { ...s.state, approved: true, position: s.state.position + 1 };
      settle(s, true);
      break;
    case 'rollback': {
      const v = buildReplayView(s.fixture, s.state);
      if (!v.rollback.available) {
        return conflict(v.rollback.code ?? 'ROLLBACK_NOT_ALLOWED', v.rollback.reason ?? 'Rollback is not available');
      }
      s.state = { ...s.state, rolledBack: true };
      break;
    }
    case 'speed':
      if (!REPLAY_SPEEDS.includes(speed as ReplaySpeed)) {
        return { httpStatus: 400, body: { code: 'INVALID_REPLAY_SPEED', error: 'speed must be 1, 2 or 4' } };
      }
      s.speed = speed as ReplaySpeed;
      if (s.status === 'playing') schedule(s);
      break;
    default:
      return { httpStatus: 400, body: { code: 'INVALID_REPLAY_ACTION', error: `action must be one of: ${REPLAY_ACTIONS.join(', ')}` } };
  }
  notify(s);
  return { httpStatus: 200, body: view(s) };
}

export function resetReplay(id: string): ReplayResult {
  const s = sessions.get(id);
  if (!s) return getReplay(id);
  stopTimer(s);
  sessions.delete(id);
  return { httpStatus: 200, body: { reset: true, replayId: id } };
}

export function resetAllReplays(): void {
  for (const id of [...sessions.keys()]) resetReplay(id);
}

export function replaySessionCount(): number {
  return sessions.size;
}
