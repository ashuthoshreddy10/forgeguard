/**
 * TaskManager.ts — Lifecycle management for Bob agent tasks.
 *
 * Persists every Bob task execution (agent_tasks row + evidence rows) and emits
 * the matching WebSocket events. Failures are recorded as failures — with the
 * invocation, exit code, stdout/stderr, timing, and a classified error — and
 * are never converted into success.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db/database';
import { emitEvent } from '../ws/EventBus';
import type { BobClient, BobTaskOptions, BobTaskResult } from './BobClient';
import type { BobMode } from './BobClient';
import { extractLastJsonBlock } from './StreamParser';
import { redactSecrets } from './redact';

/** Insert an evidence row (secrets redacted) and announce it. */
export function recordEvidence(missionId: string, taskId: string | null, phaseName: string, type: string, content: string): string {
  const id = uuidv4();
  const safe = redactSecrets(content);
  getDatabase().prepare(`
    INSERT INTO evidence (id, mission_id, task_id, phase_name, evidence_type, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, missionId, taskId, phaseName, type, safe);
  emitEvent({
    type: 'evidence.created',
    timestamp: new Date().toISOString(),
    missionId,
    payload: { evidenceId: id, evidenceType: type, phaseName, preview: safe.slice(0, 200) },
  });
  return id;
}

export interface TaskRecord {
  id: string;
  phaseId: string;
  missionId: string;
  taskType: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';
  bobProvider: string;
  bobMode: BobMode;
  workspace: string;
  prompt?: string;
  rawResponse?: string;
  structuredOutput?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  errorMessage?: string;
}

export interface RunTaskInput extends BobTaskOptions {
  phaseId: string;
  missionId: string;
  taskType: string;
  /** Phase name used to label evidence rows. */
  phaseName?: string;
  /**
   * If true, the task only counts as successful when Bob's answer contains a
   * parseable FORGEGUARD:JSON block.
   */
  requireStructuredOutput?: boolean;
}

/** Result of a task as seen by the pipeline. */
export interface TaskOutcome extends BobTaskResult {
  /** ForgeGuard's agent_tasks row ID. */
  forgeguardTaskId: string;
  /** Parsed FORGEGUARD:JSON block, if any. */
  structured: unknown | null;
}

export class TaskManager {
  constructor(private readonly bobClient: BobClient) {}

  get provider(): string {
    return this.bobClient.provider;
  }

  /** Execute a Bob task, persist all state and evidence, and return the outcome. */
  async runTask(input: RunTaskInput): Promise<TaskOutcome> {
    const db = getDatabase();
    const taskId = uuidv4();
    const now = new Date().toISOString();
    const mode: BobMode = input.mode ?? 'plan';
    const evidencePhase = input.phaseName ?? input.taskType;

    db.prepare(`
      INSERT INTO agent_tasks
        (id, phase_id, mission_id, task_type, status, bob_provider, bob_mode, workspace, prompt, started_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
    `).run(taskId, input.phaseId, input.missionId, input.taskType, this.bobClient.provider, mode,
      input.workspace, redactSecrets(input.prompt), now);

    this.addEvidence(input.missionId, taskId, evidencePhase, 'prompt', redactSecrets(input.prompt));

    emitEvent({
      type: 'agent.started',
      timestamp: now,
      missionId: input.missionId,
      payload: { taskId, taskType: input.taskType, bobMode: mode },
    });

    let result: BobTaskResult;
    try {
      result = await this.bobClient.runTask({
        ...input,
        mode,
        taskId,
        // Only real parsed stream content is forwarded as agent.output.
        onChunk: (chunk) =>
          emitEvent({
            type: 'agent.output',
            timestamp: new Date().toISOString(),
            missionId: input.missionId,
            payload: { taskId, taskType: input.taskType, chunk },
          }),
      });
    } catch (err) {
      // A thrown provider error is a failure, never a success.
      result = {
        taskId,
        success: false,
        output: '',
        durationMs: Date.now() - new Date(now).getTime(),
        error: `Bob provider threw: ${err instanceof Error ? err.message : String(err)}`,
        errorKind: 'spawn_failed',
      };
    }

    // Redact again at the persistence boundary, whatever the provider did.
    result = {
      ...result,
      output: redactSecrets(result.output ?? ''),
      ...(result.stdout !== undefined ? { stdout: redactSecrets(result.stdout) } : {}),
      ...(result.stderr !== undefined ? { stderr: redactSecrets(result.stderr) } : {}),
    };

    let structured: unknown | null = result.output ? extractLastJsonBlock(result.output) : null;
    if (result.success && input.requireStructuredOutput && structured === null) {
      result = {
        ...result,
        success: false,
        errorKind: 'no_result',
        error: 'Bob completed but did not return the required FORGEGUARD:JSON block',
      };
    }

    const completedAt = result.completedAt ?? new Date().toISOString();
    const status = result.success ? 'completed' : result.errorKind === 'timeout' ? 'timed_out' : 'failed';
    const errorMessage = result.success ? null : redactSecrets(result.error ?? 'Unknown Bob task failure');

    db.prepare(`
      UPDATE agent_tasks SET
        status = ?, raw_response = ?, structured_output = ?, completed_at = ?, duration_ms = ?, error_message = ?
      WHERE id = ?
    `).run(
      status,
      result.stdout ?? result.output ?? null,
      structured !== null ? JSON.stringify(structured) : null,
      completedAt,
      result.durationMs,
      errorMessage,
      taskId,
    );

    if (result.output) {
      this.addEvidence(input.missionId, taskId, evidencePhase, 'response', result.output);
    }
    if (structured !== null) {
      this.addEvidence(input.missionId, taskId, evidencePhase, 'structured_output', JSON.stringify(structured, null, 2));
    }

    const diagnostic = redactSecrets(JSON.stringify({
      provider: this.bobClient.provider,
      forgeguardTaskId: taskId,
      bobTaskId: result.bobTaskId ?? null,
      success: result.success,
      errorKind: result.errorKind ?? null,
      error: errorMessage,
      exitCode: result.exitCode ?? null,
      startedAt: result.startedAt ?? now,
      completedAt,
      durationMs: result.durationMs,
      invocation: result.invocation ?? null,
      stdout: result.stdout ?? null,
      stderr: result.stderr ?? null,
    }, null, 2));
    this.addEvidence(input.missionId, taskId, evidencePhase, result.success ? 'observation' : 'error', diagnostic);

    if (result.success) {
      emitEvent({
        type: 'agent.completed',
        timestamp: completedAt,
        missionId: input.missionId,
        payload: { taskId, taskType: input.taskType, durationMs: result.durationMs, success: true },
      });
    } else {
      emitEvent({
        type: 'agent.failed',
        timestamp: completedAt,
        missionId: input.missionId,
        payload: { taskId, taskType: input.taskType, error: errorMessage ?? '' },
      });
    }

    return { ...result, error: errorMessage ?? undefined, forgeguardTaskId: taskId, structured } as TaskOutcome;
  }

  /** Insert an evidence row and announce it. */
  addEvidence(missionId: string, taskId: string | null, phaseName: string, type: string, content: string): string {
    return recordEvidence(missionId, taskId, phaseName, type, content);
  }

  /** Retrieve a task record by ID. */
  getTask(taskId: string): TaskRecord | null {
    const row = getDatabase().prepare('SELECT * FROM agent_tasks WHERE id = ?').get(taskId) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  /** List all tasks for a given mission. */
  listTasksForMission(missionId: string): TaskRecord[] {
    const rows = getDatabase()
      .prepare('SELECT * FROM agent_tasks WHERE mission_id = ? ORDER BY started_at ASC')
      .all(missionId) as Record<string, unknown>[];
    return rows.map((r) => this.rowToRecord(r));
  }

  private rowToRecord(row: Record<string, unknown>): TaskRecord {
    const record: TaskRecord = {
      id: row['id'] as string,
      phaseId: row['phase_id'] as string,
      missionId: row['mission_id'] as string,
      taskType: row['task_type'] as string,
      status: row['status'] as TaskRecord['status'],
      bobProvider: row['bob_provider'] as string,
      bobMode: row['bob_mode'] as BobMode,
      workspace: row['workspace'] as string,
    };
    if (row['prompt'] != null) record.prompt = row['prompt'] as string;
    if (row['raw_response'] != null) record.rawResponse = row['raw_response'] as string;
    if (row['structured_output'] != null) record.structuredOutput = row['structured_output'] as string;
    if (row['started_at'] != null) record.startedAt = row['started_at'] as string;
    if (row['completed_at'] != null) record.completedAt = row['completed_at'] as string;
    if (row['duration_ms'] != null) record.durationMs = row['duration_ms'] as number;
    if (row['error_message'] != null) record.errorMessage = row['error_message'] as string;
    return record;
  }
}
