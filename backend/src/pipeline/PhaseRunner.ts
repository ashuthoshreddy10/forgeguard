/**
 * PhaseRunner.ts — Utilities for creating and managing pipeline phase records.
 *
 * Provides helpers to create phase DB records, update their status,
 * and broadcast phase events via the EventBus.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { emitEvent } from '../ws/EventBus';

export type PhaseName =
  | 'repo_understanding'
  | 'parallel_analysis'
  | 'change_plan'
  | 'implementation'
  | 'validation'
  | 'release_report';

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** Pipeline phases in execution order. */
export const PHASE_ORDER: PhaseName[] = [
  'repo_understanding',
  'parallel_analysis',
  'change_plan',
  'implementation',
  'validation',
  'release_report',
];

export interface PhaseRecord {
  id: string;
  missionId: string;
  phaseName: PhaseName;
  status: PhaseStatus;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  output?: string;
}

/** Create a new phase record in the database and return its ID. */
export function createPhase(missionId: string, phaseName: PhaseName): string {
  const db = getDatabase();
  const phaseId = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO pipeline_phases (id, mission_id, phase_name, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `).run(phaseId, missionId, phaseName, now);

  // Broadcast phase.started
  emitEvent({
    type: 'phase.started',
    timestamp: now,
    missionId,
    payload: { phaseId, phaseName },
  });

  return phaseId;
}

/** Mark a phase as completed. */
export function completePhase(phaseId: string, missionId: string, phaseName: PhaseName, output?: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE pipeline_phases
    SET status = 'completed', completed_at = ?, output = ?
    WHERE id = ?
  `).run(now, output ?? null, phaseId);

  const phase = db.prepare('SELECT started_at FROM pipeline_phases WHERE id = ?').get(phaseId) as { started_at: string } | undefined;
  const durationMs = phase?.started_at
    ? new Date(now).getTime() - new Date(phase.started_at).getTime()
    : 0;

  emitEvent({
    type: 'phase.completed',
    timestamp: now,
    missionId,
    payload: { phaseId, phaseName, durationMs },
  });
}

/** Mark a phase as failed. */
export function failPhase(phaseId: string, missionId: string, phaseName: PhaseName, error: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE pipeline_phases
    SET status = 'failed', completed_at = ?, error_message = ?
    WHERE id = ?
  `).run(now, error, phaseId);

  emitEvent({
    type: 'phase.failed',
    timestamp: now,
    missionId,
    payload: { phaseId, phaseName, error },
  });
}

/** Mission columns that `updateMissionStatus(extra)` may set. Keys are never taken from input. */
const UPDATABLE_MISSION_COLUMNS = [
  'repo_summary', 'change_plan', 'validation_result', 'release_report', 'rollback_ref', 'error_message',
] as const;
export type UpdatableMissionColumn = (typeof UPDATABLE_MISSION_COLUMNS)[number];

/** Update the mission status (and optionally allow-listed columns) and broadcast mission.updated. */
export function updateMissionStatus(
  missionId: string, status: string, extra?: Partial<Record<UpdatableMissionColumn, string | null>>,
): void {
  const db = getDatabase();
  const now = new Date().toISOString();

  if (extra) {
    const keys = Object.keys(extra);
    const unknown = keys.filter((k) => !(UPDATABLE_MISSION_COLUMNS as readonly string[]).includes(k));
    if (unknown.length > 0) throw new Error(`updateMissionStatus: column(s) not updatable: ${unknown.join(', ')}`);
    // Column names below come from the allow-list, not from the caller's strings.
    const columns = UPDATABLE_MISSION_COLUMNS.filter((c) => keys.includes(c));
    if (columns.length > 0) {
      const setClauses = columns.map((c) => `${c} = ?`).join(', ');
      db.prepare(`UPDATE missions SET ${setClauses}, updated_at = ? WHERE id = ?`)
        .run(...columns.map((c) => extra[c] ?? null), now, missionId);
    }
  }

  db.prepare(`UPDATE missions SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, missionId);

  emitEvent({
    type: 'mission.updated',
    timestamp: now,
    missionId,
    payload: { status },
  });
}

/**
 * Record the phases after a failure point as 'skipped' (blocked), so the
 * pipeline shows they never ran rather than leaving them looking pending.
 */
export function skipRemainingPhases(missionId: string, afterPhase: PhaseName | null, reason: string): void {
  const db = getDatabase();
  const startIdx = afterPhase ? PHASE_ORDER.indexOf(afterPhase) + 1 : 0;
  const now = new Date().toISOString();
  for (const phaseName of PHASE_ORDER.slice(startIdx)) {
    db.prepare(`
      INSERT INTO pipeline_phases (id, mission_id, phase_name, status, completed_at, error_message)
      VALUES (?, ?, ?, 'skipped', ?, ?)
    `).run(uuidv4(), missionId, phaseName, now, reason);
  }
}

/** Mark the mission failed with a human-readable reason and broadcast mission.failed. */
export function failMission(missionId: string, errorMessage: string): void {
  const now = new Date().toISOString();
  getDatabase()
    .prepare(`UPDATE missions SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?`)
    .run(errorMessage, now, missionId);
  emitEvent({ type: 'mission.updated', timestamp: now, missionId, payload: { status: 'failed', message: errorMessage } });
  emitEvent({ type: 'mission.failed', timestamp: now, missionId, payload: { error: errorMessage } });
}
