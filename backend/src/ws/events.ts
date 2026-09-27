/**
 * events.ts — Typed WebSocket event definitions for ForgeGuard.
 *
 * All events flowing from backend → frontend are typed here.
 * Frontend consumers must handle unknown event types gracefully.
 */

// ─── Event type discriminators ────────────────────────────────────────────────

export type ForgeGuardEventType =
  | 'mission.created'
  | 'mission.updated'
  | 'mission.completed'
  | 'mission.failed'
  | 'phase.started'
  | 'phase.completed'
  | 'phase.failed'
  | 'agent.started'
  | 'agent.output'
  | 'agent.completed'
  | 'agent.failed'
  | 'validation.started'
  | 'validation.completed'
  | 'evidence.created'
  | 'plan.ready'
  | 'rollback.completed'
  | 'replay.updated'
  | 'system.error';

// ─── Base event ───────────────────────────────────────────────────────────────

interface BaseEvent {
  type: ForgeGuardEventType;
  timestamp: string;
  missionId: string;
}

// ─── Mission events ───────────────────────────────────────────────────────────

export interface MissionCreatedEvent extends BaseEvent {
  type: 'mission.created';
  payload: {
    missionId: string;
    issueText: string;
    repoPath: string;
  };
}

export interface MissionUpdatedEvent extends BaseEvent {
  type: 'mission.updated';
  payload: {
    status: string;
    message?: string;
  };
}

export interface MissionCompletedEvent extends BaseEvent {
  type: 'mission.completed';
  payload: {
    /** Deterministic verdict from validation_runs; a `blocked` release never completes. */
    releaseReadiness: 'ready' | 'conditional';
    verdictReasons: string[];
    /** Bob's narrative summary (not authoritative). */
    summary: string;
    bobAssessment: 'ready' | 'conditional' | 'blocked' | null;
    discrepancy: string | null;
    /** The validation evidence the verdict is based on. */
    validation: Array<{ command: string; baseline: string; post: string; classification: string }>;
  };
}

export interface MissionFailedEvent extends BaseEvent {
  type: 'mission.failed';
  payload: { error: string };
}

// ─── Phase events ─────────────────────────────────────────────────────────────

export interface PhaseStartedEvent extends BaseEvent {
  type: 'phase.started';
  payload: {
    phaseId: string;
    phaseName: string;
  };
}

export interface PhaseCompletedEvent extends BaseEvent {
  type: 'phase.completed';
  payload: {
    phaseId: string;
    phaseName: string;
    durationMs: number;
  };
}

export interface PhaseFailedEvent extends BaseEvent {
  type: 'phase.failed';
  payload: {
    phaseId: string;
    phaseName: string;
    error: string;
  };
}

// ─── Agent task events ────────────────────────────────────────────────────────

export interface AgentStartedEvent extends BaseEvent {
  type: 'agent.started';
  payload: {
    taskId: string;
    taskType: string;
    bobMode: string;
  };
}

export interface AgentOutputEvent extends BaseEvent {
  type: 'agent.output';
  payload: {
    taskId: string;
    taskType: string;
    chunk: string;
  };
}

export interface AgentCompletedEvent extends BaseEvent {
  type: 'agent.completed';
  payload: {
    taskId: string;
    taskType: string;
    durationMs: number;
    success: boolean;
  };
}

export interface AgentFailedEvent extends BaseEvent {
  type: 'agent.failed';
  payload: {
    taskId: string;
    taskType: string;
    error: string;
  };
}

// ─── Validation events ────────────────────────────────────────────────────────

export interface ValidationStartedEvent extends BaseEvent {
  type: 'validation.started';
  payload: {
    command: string;
    kind: 'baseline' | 'post';
  };
}

export interface ValidationCompletedEvent extends BaseEvent {
  type: 'validation.completed';
  payload: {
    command: string;
    kind: 'baseline' | 'post';
    /** null only when the command timed out and was killed. */
    exitCode: number | null;
    timedOut: boolean;
    passed: boolean;
    durationMs: number;
  };
}

// ─── Evidence events ──────────────────────────────────────────────────────────

export interface EvidenceCreatedEvent extends BaseEvent {
  type: 'evidence.created';
  payload: {
    evidenceId: string;
    evidenceType: string;
    phaseName: string;
    preview: string; // first 200 chars of content
  };
}

// ─── Plan / approval events ───────────────────────────────────────────────────

export interface PlanReadyEvent extends BaseEvent {
  type: 'plan.ready';
  payload: {
    changePlan: unknown; // typed ChangePlan when pipeline is implemented
  };
}

// ─── Rollback events ─────────────────────────────────────────────────────────

export interface RollbackCompletedEvent extends BaseEvent {
  type: 'rollback.completed';
  payload: {
    rollbackRef: string;
    message: string;
  };
}

// ─── Replay (deterministic demo; never a live mission) ─────────────────────────

export interface ReplayUpdatedEvent extends BaseEvent {
  type: 'replay.updated';
  payload: { replayId: string; position: number; status: string };
}

// ─── System error ─────────────────────────────────────────────────────────────

export interface SystemErrorEvent extends BaseEvent {
  type: 'system.error';
  payload: { error: string };
}

// ─── Union type ───────────────────────────────────────────────────────────────

export type ForgeGuardEvent =
  | MissionCreatedEvent
  | MissionUpdatedEvent
  | MissionCompletedEvent
  | MissionFailedEvent
  | PhaseStartedEvent
  | PhaseCompletedEvent
  | PhaseFailedEvent
  | AgentStartedEvent
  | AgentOutputEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | ValidationStartedEvent
  | ValidationCompletedEvent
  | EvidenceCreatedEvent
  | PlanReadyEvent
  | RollbackCompletedEvent
  | ReplayUpdatedEvent
  | SystemErrorEvent;
