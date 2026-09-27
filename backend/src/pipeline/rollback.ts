/**
 * rollback.ts — Mission-specific rollback to the pre-implementation anchor.
 *
 * Gates (all must pass, in order): mission exists → not already rolled back → terminal
 * status → has an anchor → repository still allowed → anchor belongs to this mission →
 * repository lock free/acquired → HEAD unchanged → working tree still equals the state
 * this mission left (result snapshot). Only then is the anchor state restored and verified.
 *
 * getRollbackStatus() evaluates the same gates read-only (no lock, no evidence, no
 * working-tree changes) so the UI can show whether rollback is possible and why not.
 */

import { getDatabase } from '../db/database';
import { recordEvidence } from '../bob/TaskManager';
import { emitEvent } from '../ws/EventBus';
import { resolveAllowedRepo } from '../security/repoPolicy';
import { acquireRepoLock, readRepoLock, RepoLockedError, type RepoLock } from '../git/repoLock';
import { gitOk } from '../git/git';
import {
  AnchorError, currentState, diffTrees, readAnchor, readResultSnapshot, restoreAnchor, type Anchor,
} from '../git/snapshot';

export interface RollbackResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface RollbackStatus {
  available: boolean;
  code?: string;
  reason?: string;
  anchorRef?: string | null;
  details?: Record<string, unknown>;
}

const ROLLBACK_STATES = ['complete', 'failed'];

interface Rejection { httpStatus: number; code: string; error: string; details?: Record<string, unknown> }
type GateResult = { ok: true; anchor: Anchor; lock: RepoLock | null } | { ok: false; rejection: Rejection };

const rejected = (httpStatus: number, code: string, error: string, details?: Record<string, unknown>): GateResult =>
  ({ ok: false, rejection: details ? { httpStatus, code, error, details } : { httpStatus, code, error } });

interface MissionRow { id: string; repo_path: string; rollback_ref: string | null; status: string }

function loadMission(missionId: string): MissionRow | undefined {
  return getDatabase().prepare('SELECT id, repo_path, rollback_ref, status FROM missions WHERE id = ?').get(missionId) as MissionRow | undefined;
}

/** Evaluate every rollback gate. In 'execute' mode the repository lock is acquired and returned. */
async function evaluateGates(mission: MissionRow, mode: 'check' | 'execute'): Promise<GateResult> {
  if (mission.status === 'rolled_back') return rejected(409, 'ROLLBACK_ALREADY_DONE', 'This mission has already been rolled back');
  if (!ROLLBACK_STATES.includes(mission.status)) {
    return rejected(409, 'ROLLBACK_NOT_ALLOWED', `Rollback is not allowed while the mission is "${mission.status}"`);
  }
  if (!mission.rollback_ref) {
    return rejected(409, 'NO_ROLLBACK_ANCHOR', 'This mission has no rollback anchor (implementation never started)');
  }
  const repo = resolveAllowedRepo(mission.repo_path);
  if (!repo.ok) return rejected(403, repo.code, repo.error);

  let lock: RepoLock | null = null;
  try {
    const anchor = await readAnchor(repo.path, mission.rollback_ref, mission.id);
    if (mode === 'execute') {
      lock = await acquireRepoLock(anchor.repoRoot, mission.id, 'rollback');
    } else {
      const holder = await readRepoLock(anchor.repoRoot);
      if (holder) throw new RepoLockedError(holder);
    }

    const head = await gitOk(anchor.repoRoot, ['rev-parse', 'HEAD']);
    if (head !== anchor.head) {
      lock?.release();
      return rejected(409, 'ROLLBACK_HEAD_MOVED',
        'HEAD has moved since the anchor (commits were made); ForgeGuard does not rewrite branch history');
    }
    const result = await readResultSnapshot(anchor);
    if (!result) {
      lock?.release();
      return rejected(409, 'ROLLBACK_NO_RESULT_SNAPSHOT',
        'The post-mission snapshot is missing, so changes made after the mission cannot be ruled out');
    }
    const now = await currentState(anchor.repoRoot);
    if (now.workTree !== result.workTree || now.indexTree !== result.indexTree) {
      lock?.release();
      const changed = (await diffTrees(anchor.repoRoot, result.workTree, now.workTree)).map((c) => c.path);
      return rejected(409, 'ROLLBACK_CONFLICT',
        'The repository changed after this mission finished (by the developer or a later mission); rolling back would discard those changes',
        { changedPaths: changed.slice(0, 20), changedCount: changed.length, indexChanged: now.indexTree !== result.indexTree });
    }
    return { ok: true, anchor, lock };
  } catch (err) {
    lock?.release();
    if (err instanceof RepoLockedError) {
      return rejected(409, err.code, 'Another ForgeGuard operation is using this repository', { lockedBy: err.holder?.missionId ?? 'unknown' });
    }
    if (err instanceof AnchorError) return rejected(409, err.code, err.message, { anchorRef: mission.rollback_ref });
    throw err;
  }
}

/** Read-only: can this mission be rolled back right now, and if not, why? */
export async function getRollbackStatus(missionId: string): Promise<RollbackResult> {
  const mission = loadMission(missionId);
  if (!mission) return { httpStatus: 404, body: { code: 'MISSION_NOT_FOUND', error: 'Mission not found' } };
  try {
    const gate = await evaluateGates(mission, 'check');
    const status: RollbackStatus = gate.ok
      ? { available: true, anchorRef: mission.rollback_ref }
      : {
          available: false, code: gate.rejection.code, reason: gate.rejection.error, anchorRef: mission.rollback_ref,
          ...(gate.rejection.details ? { details: gate.rejection.details } : {}),
        };
    return { httpStatus: 200, body: { ...status } };
  } catch {
    return { httpStatus: 200, body: { available: false, code: 'ROLLBACK_STATUS_UNKNOWN', reason: 'Rollback status could not be determined', anchorRef: mission.rollback_ref } };
  }
}

function reject(missionId: string | null, r: Rejection): RollbackResult {
  if (missionId) {
    recordEvidence(missionId, null, 'rollback', 'error',
      JSON.stringify({ event: 'rollback_rejected', code: r.code, error: r.error, ...r.details, at: new Date().toISOString() }, null, 2));
  }
  return { httpStatus: r.httpStatus, body: { code: r.code, error: r.error, ...r.details } };
}

export async function rollbackMission(missionId: string): Promise<RollbackResult> {
  const db = getDatabase();
  const mission = loadMission(missionId);
  if (!mission) return reject(null, { httpStatus: 404, code: 'MISSION_NOT_FOUND', error: 'Mission not found' });

  let lock: RepoLock | null = null;
  try {
    const gate = await evaluateGates(mission, 'execute');
    if (!gate.ok) return reject(missionId, gate.rejection);
    lock = gate.lock;
    const { anchor } = gate;

    const startedAt = new Date().toISOString();
    const { removed, restored } = await restoreAnchor(anchor);
    const completedAt = new Date().toISOString();

    db.prepare(`UPDATE missions SET status = 'rolled_back', updated_at = ? WHERE id = ?`).run(completedAt, missionId);
    recordEvidence(missionId, null, 'rollback', 'observation', JSON.stringify({
      event: 'rollback_completed',
      anchorRef: anchor.ref, anchorCommit: anchor.commit, head: anchor.head, branch: anchor.branch,
      repository: anchor.repoRoot, removed, restored, startedAt, completedAt,
    }, null, 2));
    emitEvent({ type: 'mission.updated', timestamp: completedAt, missionId, payload: { status: 'rolled_back' } });
    emitEvent({
      type: 'rollback.completed', timestamp: completedAt, missionId,
      payload: { rollbackRef: anchor.ref, message: `Restored anchor state: ${removed.length} removed, ${restored.length} restored` },
    });
    return { httpStatus: 200, body: { message: 'Rollback completed', rollbackRef: anchor.ref, removed, restored } };
  } catch (err) {
    if (err instanceof AnchorError) {
      const status = err.code === 'ROLLBACK_VERIFY_FAILED' || err.code === 'ROLLBACK_UNSUPPORTED' ? 500 : 409;
      return reject(missionId, { httpStatus: status, code: err.code, error: err.message, details: { anchorRef: mission.rollback_ref } });
    }
    // Full git diagnostics go to evidence only; the HTTP response stays generic.
    recordEvidence(missionId, null, 'rollback', 'error', JSON.stringify({
      event: 'rollback_failed', code: 'ROLLBACK_FAILED', anchorRef: mission.rollback_ref,
      error: err instanceof Error ? err.message : String(err), at: new Date().toISOString(),
    }, null, 2));
    return { httpStatus: 500, body: { code: 'ROLLBACK_FAILED', error: 'Rollback failed; see the mission evidence for diagnostics' } };
  } finally {
    lock?.release();
  }
}
