/**
 * missions.ts — REST routes for ForgeGuard missions.
 *
 * POST /api/missions              — Create a new mission
 * GET  /api/missions              — List all missions
 * GET  /api/missions/:id          — Get a single mission
 * POST /api/missions/:id/start    — Start the pipeline for a mission
 * POST /api/missions/:id/approve  — Approve the change plan (unblocks Phase 4)
 * POST /api/missions/:id/rollback — Roll back implemented changes
 * GET  /api/missions/:id/evidence        — Get all evidence for a mission
 * GET  /api/missions/:id/tasks           — Get all agent tasks for a mission
 * GET  /api/missions/:id/phases          — Get all pipeline phases for a mission
 * GET  /api/missions/:id/validation-runs — Get all validation runs for a mission
 * GET  /api/missions/:id/release-verdict — Deterministic verdict recomputed from validation_runs
 * GET  /api/missions/:id/rollback-status — Read-only: whether rollback is possible now, and why not
 */

import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { startMission } from '../pipeline/MissionOrchestrator';
import { loadReleaseVerdict } from '../pipeline/releaseVerdict';
import { getRollbackStatus, rollbackMission } from '../pipeline/rollback';
import { resolveAllowedRepo } from '../security/repoPolicy';
import { MAX_ISSUE_TEXT_LENGTH } from '../config';

export const missionsRouter = Router();

/** POST /api/missions — create a new mission */
missionsRouter.post('/', (req: Request, res: Response) => {
  const { issueText, repoPath } = (req.body ?? {}) as { issueText?: unknown; repoPath?: unknown };

  if (typeof issueText !== 'string' || issueText.trim().length === 0) {
    res.status(400).json({ code: 'ISSUE_TEXT_REQUIRED', error: 'issueText is required' });
    return;
  }
  if (issueText.length > MAX_ISSUE_TEXT_LENGTH) {
    res.status(400).json({
      code: 'ISSUE_TEXT_TOO_LONG',
      error: `issueText must be at most ${MAX_ISSUE_TEXT_LENGTH} characters`,
      maxLength: MAX_ISSUE_TEXT_LENGTH,
      length: issueText.length,
    });
    return;
  }

  const repo = resolveAllowedRepo(repoPath);
  if (!repo.ok) {
    console.warn(`[security] Rejected mission creation: ${repo.code}`);
    res.status(repo.code === 'INVALID_REPO_PATH' ? 400 : 403).json({ code: repo.code, error: repo.error });
    return;
  }

  const db = getDatabase();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO missions (id, issue_text, repo_path, status)
    VALUES (?, ?, ?, 'created')
  `).run(id, issueText.trim(), repo.path);

  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(id);
  res.status(201).json(mission);
});

/** GET /api/missions — list all missions (most recent first) */
missionsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDatabase();
  const missions = db.prepare('SELECT * FROM missions ORDER BY created_at DESC').all();
  res.json(missions);
});

/** GET /api/missions/:id — get a single mission */
missionsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDatabase();
  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(req.params['id']);
  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  res.json(mission);
});

/** GET /api/missions/:id/evidence — get all evidence for a mission */
missionsRouter.get('/:id/evidence', (req: Request, res: Response) => {
  const db = getDatabase();
  const evidence = db.prepare(
    'SELECT rowid AS seq, * FROM evidence WHERE mission_id = ? ORDER BY rowid ASC'
  ).all(req.params['id']);
  res.json(evidence);
});

/** GET /api/missions/:id/tasks — get all agent tasks for a mission */
missionsRouter.get('/:id/tasks', (req: Request, res: Response) => {
  const db = getDatabase();
  const tasks = db.prepare(
    'SELECT rowid AS seq, * FROM agent_tasks WHERE mission_id = ? ORDER BY rowid ASC'
  ).all(req.params['id']);
  res.json(tasks);
});

/**
 * POST /api/missions/:id/start — preflight Bob availability, then start the
 * pipeline (non-blocking). Returns 503 { code: 'BOB_UNAVAILABLE' } without
 * creating any phase if Bob cannot be launched.
 */
missionsRouter.post('/:id/start', (req: Request, res: Response) => {
  startMission(req.params['id'] ?? '')
    .then((r) => res.status(r.httpStatus).json(r.body))
    .catch((err: unknown) => {
      console.error('[route] Failed to start mission:', err);
      res.status(500).json({ error: 'Failed to start mission' });
    });
});

/** POST /api/missions/:id/approve — approve the change plan and unblock Phase 4 */
missionsRouter.post('/:id/approve', (req: Request, res: Response) => {
  const db = getDatabase();
  const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(req.params['id']) as
    { id: string; status: string } | undefined;

  if (!mission) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  if (mission.status !== 'awaiting_approval') {
    res.status(409).json({ error: `Mission is not awaiting approval (status: ${mission.status})` });
    return;
  }

  db.prepare(`UPDATE missions SET plan_approved = 1, updated_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    mission.id
  );

  res.json({ message: 'Plan approved', missionId: mission.id });
});

/** POST /api/missions/:id/rollback — restore this mission's pre-implementation anchor */
missionsRouter.post('/:id/rollback', (req: Request, res: Response) => {
  rollbackMission(req.params['id'] ?? '')
    .then((r) => res.status(r.httpStatus).json(r.body))
    .catch((err: unknown) => {
      console.error('[route] Rollback failed unexpectedly:', err);
      res.status(500).json({ code: 'ROLLBACK_FAILED', error: 'Rollback failed' });
    });
});

/** GET /api/missions/:id/phases — get all pipeline phases for a mission */
missionsRouter.get('/:id/phases', (req: Request, res: Response) => {
  const db = getDatabase();
  const phases = db.prepare(
    'SELECT rowid AS seq, * FROM pipeline_phases WHERE mission_id = ? ORDER BY rowid ASC'
  ).all(req.params['id']);
  res.json(phases);
});

/** GET /api/missions/:id/validation-runs — get all validation runs for a mission */
missionsRouter.get('/:id/validation-runs', (req: Request, res: Response) => {
  const db = getDatabase();
  const runs = db.prepare(
    'SELECT rowid AS seq, * FROM validation_runs WHERE mission_id = ? ORDER BY rowid ASC'
  ).all(req.params['id']);
  res.json(runs);
});

/** GET /api/missions/:id/rollback-status — read-only evaluation of the rollback gates */
missionsRouter.get('/:id/rollback-status', (req: Request, res: Response) => {
  getRollbackStatus(req.params['id'] ?? '')
    .then((r) => res.status(r.httpStatus).json(r.body))
    .catch((err: unknown) => {
      console.error('[route] Rollback status failed unexpectedly:', err);
      res.status(500).json({ code: 'ROLLBACK_STATUS_UNKNOWN', error: 'Rollback status could not be determined' });
    });
});

/** GET /api/missions/:id/release-verdict — deterministic verdict for the mission's latest run */
missionsRouter.get('/:id/release-verdict', (req: Request, res: Response) => {
  const db = getDatabase();
  const id = req.params['id'] ?? '';
  if (!db.prepare('SELECT 1 FROM missions WHERE id = ?').get(id)) {
    res.status(404).json({ error: 'Mission not found' });
    return;
  }
  res.json(loadReleaseVerdict(db, id));
});
