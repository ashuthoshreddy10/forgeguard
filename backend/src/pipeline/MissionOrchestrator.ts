/**
 * MissionOrchestrator.ts — Top-level ForgeGuard pipeline runner.
 *
 * Flow:
 *   1. Repo Understanding  (baseline validation under the repository lock, then Bob)
 *   2. Parallel Specialist Analysis (5 independent Bob Shell sessions in parallel)
 *   3. Change Plan Synthesis → developer approval
 *   4. Implementation  (repository lock + rollback anchor first; Bob only if both succeed)
 *   5. Validation      (same commands again, then the deterministic verdict)
 *   6. Release Report  (Bob narrative; never overrides the verdict)
 *
 * State rules (truthful pipeline):
 *   - A phase is marked `completed` only after its work actually succeeded.
 *   - Any failure fails its phase, the remaining phases are recorded as `skipped`,
 *     and the mission is marked `failed` with a human-readable error_message.
 *   - The release verdict is computed by releaseVerdict.ts from stored rows.
 *   - The repository lock is held from anchor creation until the post-mission
 *     result snapshot is recorded (see docs/ROLLBACK_DESIGN.md).
 *
 * Pipeline state is in-process; a server restart does not resume a mission.
 */

import { spawn } from 'child_process';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { createBobClient, type BobClient, type BobProviderStatus } from '../bob/BobClient';
import { TaskManager, recordEvidence, type TaskOutcome } from '../bob/TaskManager';
import { redactSecrets } from '../bob/redact';
import { emitEvent } from '../ws/EventBus';
import { getValidationTimeoutMs } from '../config';
import { resolveAllowedRepo } from '../security/repoPolicy';
import { acquireRepoLock, readRepoLock, RepoLockedError, type LockPurpose, type RepoLock } from '../git/repoLock';
import {
  AnchorError,
  createAnchor,
  currentState,
  deleteAnchor,
  recordResultSnapshot,
  resolveRepoRoot,
  type Anchor,
} from '../git/snapshot';
import {
  createPhase,
  completePhase,
  failPhase,
  failMission,
  skipRemainingPhases,
  updateMissionStatus,
  type PhaseName,
} from './PhaseRunner';
import {
  repoUnderstandingPrompt,
  codeImpactPrompt,
  testEngineerPrompt,
  securityAnalystPrompt,
  apiCompatPrompt,
  docAnalystPrompt,
  changePlanPrompt,
  implementationPrompt,
  releaseReportPrompt,
} from './prompts';
import {
  REQUIRED_VALIDATION_COMMANDS,
  loadReleaseVerdict,
  normaliseBobAssessment,
  reconcileBobAssessment,
  type ReleaseVerdictResult,
  type RunKind,
} from './releaseVerdict';

const APPROVAL_POLL_INTERVAL_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
const KILL_GRACE_MS = 5_000;

/** Mission statuses in which a pipeline is running or waiting. */
export const IN_PROGRESS_STATUSES = ['analyzing', 'planning', 'awaiting_approval', 'implementing', 'validating'];

interface MissionRow {
  id: string;
  issue_text: string;
  repo_path: string;
  status: string;
  plan_approved: 0 | 1;
  repo_summary: string | null;
  change_plan: string | null;
  rollback_ref: string | null;
}

export interface ValidationRunResult {
  runId: string;
  kind: RunKind;
  command: string;
  /** null only when the command timed out and was killed. */
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  passed: boolean;
  durationMs: number;
}

export interface CommandExecution {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface OrchestratorOptions {
  bobClient?: BobClient;
  /**
   * Override how a single validation command is executed (tests only).
   * Rows are still persisted to validation_runs by the orchestrator.
   */
  executeValidationCommand?: (command: string, cwd: string, kind: RunKind, timeoutMs: number) => Promise<CommandExecution>;
  validationTimeoutMs?: number;
  approvalPollIntervalMs?: number;
  approvalTimeoutMs?: number;
}

/** A phase whose work did not succeed. */
class PhaseFailure extends Error {
  constructor(readonly phase: PhaseName, readonly reason: string) {
    super(reason);
  }
}

type PhaseWorkResult<T> = { ok: true; value: T; output?: string } | { ok: false; error: string };

function describeTaskFailure(taskType: string, t: TaskOutcome): string {
  return `${taskType} ${t.errorKind ? `[${t.errorKind}] ` : ''}${t.error ?? 'failed'}`;
}

function describeRun(r: ValidationRunResult): string {
  if (r.timedOut) return `TIMED OUT after ${r.durationMs} ms`;
  return `exit ${r.exitCode} (${r.passed ? 'pass' : 'FAIL'}, ${r.durationMs} ms)`;
}

function summariseRuns(label: string, runs: ValidationRunResult[]): string {
  return `${label}:\n` + runs.map((r) => `  ${r.command}: ${describeRun(r)}`).join('\n');
}

/** Code + message for repository/lock/anchor errors. */
function repoErrorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof RepoLockedError) return { code: err.code, message: err.message };
  if (err instanceof AnchorError) return { code: err.code, message: err.message };
  return { code: 'REPO_ERROR', message: err instanceof Error ? err.message : String(err) };
}

export class MissionOrchestrator {
  private readonly bobClient: BobClient;
  private readonly taskManager: TaskManager;
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
    this.bobClient = options.bobClient ?? createBobClient();
    this.taskManager = new TaskManager(this.bobClient);
  }

  /** Run a phase: complete it only if `work` succeeds; otherwise fail it and throw. */
  private async phase<T>(
    missionId: string,
    name: PhaseName,
    work: (phaseId: string) => Promise<PhaseWorkResult<T>>,
  ): Promise<T> {
    const phaseId = createPhase(missionId, name);
    let result: PhaseWorkResult<T>;
    try {
      result = await work(phaseId);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      const reason = redactSecrets(result.error);
      failPhase(phaseId, missionId, name, reason);
      throw new PhaseFailure(name, reason);
    }
    completePhase(phaseId, missionId, name, result.output);
    return result.value;
  }

  /** Acquire the repository lock; on failure record error evidence and return a reason. */
  private async lockRepo(
    missionId: string, repoPath: string, purpose: LockPurpose, evidencePhase: string,
  ): Promise<{ ok: true; root: string; lock: RepoLock } | { ok: false; error: string }> {
    try {
      const root = await resolveRepoRoot(repoPath);
      const lock = await acquireRepoLock(root, missionId, purpose);
      if (lock.tookOverStale) {
        recordEvidence(missionId, null, evidencePhase, 'observation',
          `Took over a stale repository lock left by a dead process: ${JSON.stringify(lock.tookOverStale)}`);
      }
      return { ok: true, root, lock };
    } catch (err) {
      const { code, message } = repoErrorInfo(err);
      recordEvidence(missionId, null, evidencePhase, 'error',
        JSON.stringify({ event: 'repo_lock_failed', purpose, code, error: message, at: new Date().toISOString() }, null, 2));
      return { ok: false, error: `${code}: ${message}` };
    }
  }

  /** Run the full pipeline for a given mission. */
  async run(missionId: string): Promise<void> {
    const db = getDatabase();
    let lastCompleted: PhaseName | null = null;
    // Held from anchor creation until the result snapshot is recorded.
    const repoState: { lock: RepoLock | null; anchor: Anchor | null } = { lock: null, anchor: null };

    try {
      const mission = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as MissionRow | undefined;
      if (!mission) throw new Error(`Mission ${missionId} not found`);
      const repo = mission.repo_path;

      // ── Phase 1: Baseline validation + Repo Understanding ──────────────────
      updateMissionStatus(missionId, 'analyzing');
      const { summary: repoSummaryStr, baselineTree } = await this.phase(missionId, 'repo_understanding', async (phaseId) => {
        const locked = await this.lockRepo(missionId, repo, 'baseline', 'baseline_validation');
        if (!locked.ok) return { ok: false, error: `Baseline validation could not start: ${locked.error}` };
        let baselineWorkTree: string;
        try {
          const runs = await this.runValidationSuite(missionId, phaseId, locked.root, 'baseline');
          baselineWorkTree = (await currentState(locked.root)).workTree;
          recordEvidence(missionId, null, 'baseline_validation', 'observation',
            `${summariseRuns('Baseline validation (before analysis and implementation)', runs)}\nWorking-tree snapshot: ${baselineWorkTree}`);
        } finally {
          locked.lock.release();
        }

        const t = await this.taskManager.runTask({
          phaseId, missionId, phaseName: 'repo_understanding',
          taskType: 'repo_understander',
          prompt: repoUnderstandingPrompt(mission.issue_text, repo),
          workspace: repo, mode: 'ask', allowFileWrites: false,
          requireStructuredOutput: true,
        });
        if (!t.success) return { ok: false, error: describeTaskFailure('repo_understander', t) };
        const s = JSON.stringify(t.structured);
        db.prepare(`UPDATE missions SET repo_summary = ? WHERE id = ?`).run(s, missionId);
        return { ok: true, value: { summary: s, baselineTree: baselineWorkTree }, output: s };
      });
      lastCompleted = 'repo_understanding';

      // ── Phase 2: Parallel Specialist Analysis ──────────────────────────────
      const analysisSummary = await this.phase(missionId, 'parallel_analysis', async (phaseId) => {
        const specialists = [
          { taskType: 'code_impact_analyst', prompt: codeImpactPrompt(mission.issue_text, repoSummaryStr) },
          { taskType: 'test_engineer', prompt: testEngineerPrompt(mission.issue_text, repoSummaryStr) },
          { taskType: 'security_analyst', prompt: securityAnalystPrompt(mission.issue_text, repoSummaryStr) },
          { taskType: 'api_compat_analyst', prompt: apiCompatPrompt(mission.issue_text, repoSummaryStr) },
          { taskType: 'doc_analyst', prompt: docAnalystPrompt(mission.issue_text, repoSummaryStr) },
        ];
        const results = await Promise.all(
          specialists.map((s) =>
            this.taskManager.runTask({
              phaseId, missionId, phaseName: 'parallel_analysis',
              taskType: s.taskType, prompt: s.prompt,
              workspace: repo, mode: 'ask', allowFileWrites: false,
              requireStructuredOutput: true,
            }),
          ),
        );
        const failed = results
          .map((r, i) => ({ r, taskType: specialists[i]!.taskType }))
          .filter(({ r }) => !r.success);
        if (failed.length > 0) {
          return {
            ok: false,
            error: `${failed.length} of ${specialists.length} specialist tasks failed: ` +
              failed.map(({ r, taskType }) => describeTaskFailure(taskType, r)).join('; '),
          };
        }
        const summary = results
          .map((r, i) => `=== ${specialists[i]!.taskType} ===\n${JSON.stringify(r.structured)}`)
          .join('\n\n');
        return { ok: true, value: summary, output: summary };
      });
      lastCompleted = 'parallel_analysis';

      // ── Phase 3: Change Plan Synthesis ─────────────────────────────────────
      updateMissionStatus(missionId, 'planning');
      const changePlan = await this.phase(missionId, 'change_plan', async (phaseId) => {
        const t = await this.taskManager.runTask({
          phaseId, missionId, phaseName: 'change_plan',
          taskType: 'plan_synthesizer',
          prompt: changePlanPrompt(mission.issue_text, analysisSummary),
          workspace: repo, mode: 'plan', allowFileWrites: false,
          requireStructuredOutput: true,
        });
        if (!t.success) return { ok: false, error: describeTaskFailure('plan_synthesizer', t) };
        const plan = t.structured as { summary?: unknown; steps?: unknown } | null;
        if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.steps) || plan.steps.length === 0) {
          return { ok: false, error: 'plan_synthesizer returned a change plan without a summary and at least one step' };
        }
        const s = JSON.stringify(plan);
        db.prepare(`UPDATE missions SET change_plan = ? WHERE id = ?`).run(s, missionId);
        return { ok: true, value: plan, output: s };
      });
      lastCompleted = 'change_plan';

      updateMissionStatus(missionId, 'awaiting_approval');
      emitEvent({ type: 'plan.ready', timestamp: new Date().toISOString(), missionId, payload: { changePlan } });

      await this.waitForApproval(missionId);
      const approved = db.prepare('SELECT * FROM missions WHERE id = ?').get(missionId) as MissionRow;

      // ── Phase 4: Rollback anchor, then Implementation ──────────────────────
      updateMissionStatus(missionId, 'implementing');
      await this.phase(missionId, 'implementation', async (phaseId) => {
        const locked = await this.lockRepo(missionId, approved.repo_path, 'implementation', 'implementation');
        if (!locked.ok) return { ok: false, error: `Implementation not started: ${locked.error}` };
        repoState.lock = locked.lock;

        let anchor: Anchor;
        try {
          anchor = await createAnchor(locked.root, missionId);
        } catch (err) {
          const { code, message } = repoErrorInfo(err);
          recordEvidence(missionId, null, 'implementation', 'error', JSON.stringify({
            event: 'rollback_anchor_failed', code, error: message, repository: locked.root, at: new Date().toISOString(),
          }, null, 2));
          return { ok: false, error: `Rollback anchor could not be created, implementation not started: ${code}: ${message}` };
        }
        if (anchor.workTree !== baselineTree) {
          await deleteAnchor(anchor).catch(() => undefined);
          const message = 'The working tree changed between baseline validation and implementation, so the baseline ' +
            'no longer describes the code Bob would change. Re-run the mission.';
          recordEvidence(missionId, null, 'implementation', 'error', JSON.stringify({
            event: 'rollback_anchor_rejected', code: 'REPO_CHANGED_SINCE_BASELINE', error: message,
            baselineWorkTree: baselineTree, currentWorkTree: anchor.workTree, at: new Date().toISOString(),
          }, null, 2));
          return { ok: false, error: `REPO_CHANGED_SINCE_BASELINE: ${message}` };
        }
        repoState.anchor = anchor;
        db.prepare(`UPDATE missions SET rollback_ref = ?, updated_at = ? WHERE id = ?`).run(anchor.ref, new Date().toISOString(), missionId);
        recordEvidence(missionId, null, 'implementation', 'observation', JSON.stringify({
          event: 'rollback_anchor_created',
          ref: anchor.ref, commit: anchor.commit, indexCommit: anchor.indexCommit,
          head: anchor.head, branch: anchor.branch, workTree: anchor.workTree, indexTree: anchor.indexTree,
          repository: anchor.repoRoot, createdAt: anchor.createdAt,
        }, null, 2));

        const t = await this.taskManager.runTask({
          phaseId, missionId, phaseName: 'implementation',
          taskType: 'implementer',
          prompt: implementationPrompt(mission.issue_text, approved.change_plan ?? JSON.stringify(changePlan)),
          workspace: approved.repo_path, mode: 'agent', allowFileWrites: true,
          timeoutMs: 300_000,
        });
        if (!t.success) return { ok: false, error: describeTaskFailure('implementer', t) };
        return { ok: true, value: null, output: t.output };
      });
      lastCompleted = 'implementation';

      // ── Phase 5: Validation ────────────────────────────────────────────────
      updateMissionStatus(missionId, 'validating');
      const { post: validationResults, verdict } = await this.phase(missionId, 'validation', async (phaseId) => {
        const post = await this.runValidationSuite(missionId, phaseId, approved.repo_path, 'post');
        // The verdict is computed from the stored rows, not from the in-memory results.
        const v = loadReleaseVerdict(db, missionId);
        const serialized = JSON.stringify({ releaseVerdict: v, post });
        db.prepare(`UPDATE missions SET validation_result = ? WHERE id = ?`).run(serialized, missionId);
        this.taskManager.addEvidence(missionId, null, 'validation', 'observation',
          `Deterministic release verdict: ${v.verdict ?? 'none'}\n${JSON.stringify(v, null, 2)}`);
        if (v.verdict === null) return { ok: false, error: `No release verdict: ${v.reasons.join('; ')}` };
        if (v.verdict === 'blocked') return { ok: false, error: `Release blocked: ${v.reasons.join('; ')}` };
        return { ok: true, value: { post, verdict: v }, output: JSON.stringify(v) };
      });
      lastCompleted = 'validation';
      const finalVerdict = verdict.verdict as 'ready' | 'conditional';

      // ── Phase 6: Release Report (narrative only) ───────────────────────────
      const report = await this.phase(missionId, 'release_report', async (phaseId) => {
        const validationSummary = formatVerdictForPrompt(verdict, validationResults);
        const t = await this.taskManager.runTask({
          phaseId, missionId, phaseName: 'release_report',
          taskType: 'release_engineer',
          prompt: releaseReportPrompt(mission.issue_text, validationSummary, finalVerdict),
          workspace: approved.repo_path, mode: 'plan', allowFileWrites: false,
          requireStructuredOutput: true,
        });
        if (!t.success) return { ok: false, error: describeTaskFailure('release_engineer', t) };
        const r = t.structured as { releaseReadiness?: unknown; summary?: unknown };
        if (normaliseBobAssessment(r.releaseReadiness) === null) {
          return { ok: false, error: `Release report has no valid releaseReadiness (got ${JSON.stringify(r.releaseReadiness)})` };
        }
        if (typeof r.summary !== 'string' || !r.summary.trim()) {
          return { ok: false, error: 'Release report is missing a summary' };
        }
        const reconciliation = reconcileBobAssessment(finalVerdict, r.releaseReadiness);
        if (reconciliation.discrepancy) {
          this.taskManager.addEvidence(missionId, t.forgeguardTaskId, 'release_report', 'observation',
            `Verdict discrepancy: ${reconciliation.discrepancy}`);
        }
        const stored = {
          verdict: finalVerdict,
          verdictSource: 'deterministic (validation_runs)',
          verdictReasons: verdict.reasons,
          bobAssessment: reconciliation.bobAssessment,
          agreesWithVerdict: reconciliation.agreesWithVerdict,
          discrepancy: reconciliation.discrepancy,
          bobNarrative: t.structured,
        };
        const s = JSON.stringify(stored);
        db.prepare(`UPDATE missions SET release_report = ? WHERE id = ?`).run(s, missionId);
        return { ok: true, value: { summary: r.summary, ...reconciliation }, output: s };
      });

      // ── Mission complete ───────────────────────────────────────────────────
      updateMissionStatus(missionId, 'complete');
      emitEvent({
        type: 'mission.completed',
        timestamp: new Date().toISOString(),
        missionId,
        payload: {
          releaseReadiness: finalVerdict,
          verdictReasons: verdict.reasons,
          summary: report.summary,
          bobAssessment: report.bobAssessment,
          discrepancy: report.discrepancy,
          validation: verdict.commands.map((c) => ({
            command: c.command, baseline: c.baseline, post: c.post, classification: c.classification,
          })),
        },
      });
    } catch (err) {
      let message: string;
      if (err instanceof PhaseFailure) {
        message = `Phase "${err.phase}" failed: ${err.reason}`;
        skipRemainingPhases(missionId, err.phase, `Blocked: phase "${err.phase}" failed`);
      } else {
        message = err instanceof Error ? err.message : String(err);
        skipRemainingPhases(missionId, lastCompleted, `Blocked: ${message}`);
      }
      message = redactSecrets(message);
      console.error(`[pipeline] Mission ${missionId} failed: ${message}`);
      failMission(missionId, message);
    } finally {
      if (repoState.anchor) {
        try {
          const r = await recordResultSnapshot(repoState.anchor, missionId);
          recordEvidence(missionId, null, 'rollback', 'observation', JSON.stringify({
            event: 'result_snapshot_recorded', ref: r.ref, workTree: r.workTree, indexTree: r.indexTree,
            anchorRef: repoState.anchor.ref, at: new Date().toISOString(),
          }, null, 2));
        } catch (err) {
          recordEvidence(missionId, null, 'rollback', 'error', JSON.stringify({
            event: 'result_snapshot_failed', anchorRef: repoState.anchor.ref,
            error: err instanceof Error ? err.message : String(err), at: new Date().toISOString(),
          }, null, 2));
        }
      }
      repoState.lock?.release();
    }
  }

  /** Poll the DB until plan_approved = 1 or timeout. */
  private async waitForApproval(missionId: string): Promise<void> {
    const startTime = Date.now();
    const interval = this.options.approvalPollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS;
    const timeout = this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const poll = (): void => {
        if (Date.now() - startTime > timeout) {
          reject(new Error(`Plan approval timed out after ${timeout}ms`));
          return;
        }
        const row = getDatabase().prepare('SELECT plan_approved, status FROM missions WHERE id = ?').get(missionId) as
          { plan_approved: 0 | 1; status: string } | undefined;
        if (!row) {
          reject(new Error(`Mission ${missionId} not found during approval wait`));
          return;
        }
        if (row.status === 'failed' || row.status === 'rolled_back') {
          reject(new Error(`Mission was cancelled: ${row.status}`));
          return;
        }
        if (row.plan_approved === 1) {
          resolve();
          return;
        }
        setTimeout(poll, interval);
      };
      poll();
    });
  }

  /** Run every required validation command, persisting each run to validation_runs. */
  private async runValidationSuite(
    missionId: string, phaseId: string, repoPath: string, kind: RunKind,
  ): Promise<ValidationRunResult[]> {
    const results: ValidationRunResult[] = [];
    for (const command of REQUIRED_VALIDATION_COMMANDS) {
      results.push(await this.recordValidationRun(command, repoPath, missionId, phaseId, kind));
    }
    return results;
  }

  private async recordValidationRun(
    command: string, cwd: string, missionId: string, phaseId: string, kind: RunKind,
  ): Promise<ValidationRunResult> {
    const db = getDatabase();
    const runId = uuidv4();
    const timeoutMs = this.options.validationTimeoutMs ?? getValidationTimeoutMs();
    const startTime = Date.now();
    const startedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO validation_runs (id, mission_id, phase_id, run_kind, command, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, missionId, phaseId, kind, command, startedAt);
    emitEvent({ type: 'validation.started', timestamp: startedAt, missionId, payload: { command, kind } });

    let execution: CommandExecution;
    try {
      execution = await (this.options.executeValidationCommand ?? executeCommand)(command, cwd, kind, timeoutMs);
    } catch (err) {
      execution = { exitCode: 1, timedOut: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
    const timedOut = execution.timedOut === true;
    const exitCode = timedOut ? null : typeof execution.exitCode === 'number' ? execution.exitCode : 1;
    const stdout = redactSecrets(execution.stdout);
    const stderr = redactSecrets(execution.stderr);
    const passed = !timedOut && exitCode === 0;
    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    db.prepare(`
      UPDATE validation_runs
      SET exit_code = ?, timed_out = ?, stdout = ?, stderr = ?, passed = ?, completed_at = ?, duration_ms = ?
      WHERE id = ?
    `).run(exitCode, timedOut ? 1 : 0, stdout, stderr, passed ? 1 : 0, completedAt, durationMs, runId);

    if (timedOut) {
      recordEvidence(missionId, null, kind === 'baseline' ? 'baseline_validation' : 'validation', 'error', JSON.stringify({
        event: 'validation_timeout', code: 'VALIDATION_TIMEOUT', command, kind, timeoutMs,
        startedAt, completedAt, durationMs, stdout, stderr,
      }, null, 2));
    }
    emitEvent({
      type: 'validation.completed',
      timestamp: completedAt,
      missionId,
      payload: { command, kind, exitCode, timedOut, passed, durationMs },
    });
    return { runId, kind, command, exitCode, timedOut, stdout, stderr, passed, durationMs };
  }
}

/** Kill a process and all of its descendants. */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    // With shell: true the child is cmd.exe; npm and node run below it, so the whole tree must go.
    const taskkill = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      .on('error', () => undefined);
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM'); // detached: the child leads its own process group
  } catch {
    return;
  }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 2_000).unref();
}

/**
 * Run one fixed validation command in `cwd` and capture its output verbatim.
 * After `timeoutMs` the whole process tree is killed and the result is marked timed out,
 * keeping whatever stdout/stderr was produced before the kill.
 */
export function executeCommand(command: string, cwd: string, _kind?: RunKind, timeoutMs = getValidationTimeoutMs()): Promise<CommandExecution> {
  return new Promise((resolve) => {
    // Commands are fixed constants (never derived from input); a shell is
    // only used on Windows so that `npm` resolves to npm.cmd.
    const [cmd, ...args] = command.split(' ');
    const child = spawn(cmd!, args, {
      cwd,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => stdoutChunks.push(d));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (d: string) => stderrChunks.push(d));

    let done = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null, extraStderr = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        exitCode: timedOut ? null : exitCode ?? 1,
        timedOut,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join('') + extraStderr,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      // If the pipes never close (an orphan holds them), stop waiting and detach.
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on('close', (code) => finish(code));
    child.on('error', (err) => finish(1, err.message));
  });
}

function formatVerdictForPrompt(verdict: ReleaseVerdictResult, post: ValidationRunResult[]): string {
  const table = verdict.commands
    .map((c) => `- ${c.command}: baseline ${c.baseline}${c.baselineExitCode !== null ? ` (exit ${c.baselineExitCode})` : ''}, ` +
      `post ${c.post}${c.postExitCode !== null ? ` (exit ${c.postExitCode})` : ''} → ${c.classification}`)
    .join('\n');
  const outputs = post
    .map((v) => `Command: ${v.command}\n${v.timedOut ? 'Timed out' : `Exit code: ${v.exitCode}`}\n${v.stdout}`)
    .join('\n---\n');
  return `Per-command comparison (baseline = before implementation, post = after):\n${table}\n\n` +
    `Verdict reasons:\n${verdict.reasons.map((r) => `- ${r}`).join('\n')}\n\n` +
    `Post-implementation output:\n${outputs}`;
}

// ─── Mission start (preflight + launch) ───────────────────────────────────────

export interface StartMissionResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

/**
 * Start a mission after the preflight checks: rollback state, repository allow-list,
 * Git repository, repository lock, Bob availability. A check that can never pass for
 * this mission (repository not allowed / not Git, Bob unavailable) fails the mission
 * with error evidence; transient conflicts (lock held, rollback pending) do not.
 */
export async function startMission(
  missionId: string,
  options: OrchestratorOptions = {},
): Promise<StartMissionResult> {
  const db = getDatabase();
  type Row = { id: string; status: string; repo_path: string; rollback_ref: string | null };
  const getMission = (): Row | undefined =>
    db.prepare('SELECT id, status, repo_path, rollback_ref FROM missions WHERE id = ?').get(missionId) as Row | undefined;

  const before = getMission();
  if (!before) return { httpStatus: 404, body: { code: 'MISSION_NOT_FOUND', error: 'Mission not found' } };
  if (IN_PROGRESS_STATUSES.includes(before.status)) {
    return { httpStatus: 409, body: { error: `Mission is already in progress (status: ${before.status})` } };
  }
  if (before.rollback_ref && before.status !== 'rolled_back') {
    return {
      httpStatus: 409,
      body: { code: 'ROLLBACK_PENDING', error: 'This mission has an implementation anchor that was not rolled back; roll it back before re-running' },
    };
  }

  const preflightFail = (httpStatus: number, code: string, error: string): StartMissionResult => {
    recordEvidence(missionId, null, 'preflight', 'error', JSON.stringify({ code, error, at: new Date().toISOString() }, null, 2));
    failMission(missionId, `${code}: ${error}`);
    return { httpStatus, body: { code, error } };
  };

  const repo = resolveAllowedRepo(before.repo_path);
  if (!repo.ok) return preflightFail(403, repo.code, repo.error);
  let root: string;
  try {
    root = await resolveRepoRoot(repo.path);
  } catch (err) {
    const { code, message } = repoErrorInfo(err);
    return preflightFail(422, code, message);
  }
  const holder = await readRepoLock(root);
  if (holder && holder.missionId !== missionId) {
    return { httpStatus: 409, body: { code: 'REPO_LOCKED', error: 'Another ForgeGuard mission is operating on this repository', lockedBy: holder.missionId } };
  }

  const bobClient = options.bobClient ?? createBobClient();
  let status: BobProviderStatus;
  try {
    status = await bobClient.checkAvailability();
  } catch (err) {
    status = {
      provider: bobClient.provider,
      available: false,
      code: 'BOB_UNAVAILABLE',
      error: `Availability check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Re-check after the async preflight so two concurrent starts cannot both launch.
  const after = getMission();
  if (!after) return { httpStatus: 404, body: { code: 'MISSION_NOT_FOUND', error: 'Mission not found' } };
  if (IN_PROGRESS_STATUSES.includes(after.status)) {
    return { httpStatus: 409, body: { error: `Mission is already in progress (status: ${after.status})` } };
  }

  if (!status.available) {
    const message = redactSecrets(`BOB_UNAVAILABLE: ${status.error ?? 'Bob provider is not available'}`);
    new TaskManager(bobClient).addEvidence(missionId, null, 'preflight', 'error', redactSecrets(JSON.stringify(status, null, 2)));
    failMission(missionId, message);
    return { httpStatus: 503, body: { code: 'BOB_UNAVAILABLE', error: message, diagnostics: status } };
  }

  // Reset per-run state so a re-run never inherits an earlier approval, report or anchor.
  db.prepare(`
    UPDATE missions SET plan_approved = 0, error_message = NULL, repo_summary = NULL, change_plan = NULL,
      validation_result = NULL, release_report = NULL, rollback_ref = NULL, repo_path = ?, updated_at = ? WHERE id = ?
  `).run(repo.path, new Date().toISOString(), missionId);
  updateMissionStatus(missionId, 'analyzing');

  const orchestrator = new MissionOrchestrator({ ...options, bobClient });
  orchestrator.run(missionId).catch((err: unknown) => {
    console.error(`[pipeline] Unhandled pipeline error for mission ${missionId}:`, err);
  });

  return {
    httpStatus: 202,
    body: { message: 'Pipeline started', missionId, bob: { provider: status.provider, version: status.version } },
  };
}
