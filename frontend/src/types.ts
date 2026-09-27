/**
 * types.ts — Frontend mirror of the backend data model (REST responses and WS events).
 * The backend is the authority for every status, verdict and rollback decision.
 */

export type MissionStatus =
  | 'created'
  | 'analyzing'
  | 'planning'
  | 'awaiting_approval'
  | 'implementing'
  | 'validating'
  | 'complete'
  | 'failed'
  | 'rolled_back';

export type PhaseName =
  | 'repo_understanding'
  | 'parallel_analysis'
  | 'change_plan'
  | 'implementation'
  | 'validation'
  | 'release_report';

export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type AgentTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timed_out';

export interface Mission {
  id: string;
  created_at: string;
  updated_at: string;
  status: MissionStatus;
  issue_text: string;
  repo_path: string;
  repo_summary?: string | null;
  change_plan?: string | null;
  plan_approved: 0 | 1;
  validation_result?: string | null;
  release_report?: string | null;
  rollback_ref?: string | null;
  error_message?: string | null;
}

export interface PipelinePhase {
  /** Insertion order from the backend (SQLite rowid); newer rows have larger values. */
  seq?: number;
  id: string;
  mission_id: string;
  phase_name: PhaseName | string;
  status: PhaseStatus;
  started_at?: string | null;
  completed_at?: string | null;
  error_message?: string | null;
  output?: string | null;
}

export interface AgentTask {
  seq?: number;
  id: string;
  phase_id: string;
  mission_id: string;
  task_type: string;
  status: AgentTaskStatus;
  bob_provider: string;
  bob_mode: string;
  workspace: string;
  prompt?: string | null;
  raw_response?: string | null;
  structured_output?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  error_message?: string | null;
}

export type EvidenceType =
  | 'prompt' | 'response' | 'tool_call' | 'structured_output' | 'command_output' | 'observation' | 'error';

export interface EvidenceItem {
  seq?: number;
  id: string;
  mission_id: string;
  task_id?: string | null;
  phase_name: string;
  evidence_type: EvidenceType;
  content: string;
  created_at: string;
  related_file?: string | null;
}

export interface ValidationRun {
  seq?: number;
  id: string;
  mission_id: string;
  phase_id: string | null;
  run_kind: 'baseline' | 'post';
  command: string;
  exit_code: number | null;
  timed_out?: 0 | 1;
  stdout: string | null;
  stderr: string | null;
  passed: 0 | 1 | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
}

export type ReleaseVerdict = 'ready' | 'conditional' | 'blocked';

export interface CommandVerdict {
  command: string;
  baseline: 'pass' | 'fail' | 'timed_out' | 'missing';
  post: 'pass' | 'fail' | 'timed_out' | 'missing';
  baselineExitCode: number | null;
  postExitCode: number | null;
  baselineRunId: string | null;
  postRunId: string | null;
  classification: string;
}

/** GET /api/missions/:id/release-verdict */
export interface ReleaseVerdictResult {
  verdict: ReleaseVerdict | null;
  reasons: string[];
  commands: CommandVerdict[];
  requiredCommands: string[];
  implementationSucceeded: boolean | null;
}

/** GET /api/missions/:id/rollback-status */
export interface RollbackStatus {
  available: boolean;
  code?: string;
  reason?: string;
  anchorRef?: string | null;
  details?: { changedPaths?: string[]; changedCount?: number; lockedBy?: string; [k: string]: unknown };
}

/** Safe subset of the backend's BobProviderStatus (paths and commands are never displayed). */
export interface BobDiagnostics {
  provider?: string;
  available?: boolean;
  code?: string;
  version?: string;
  error?: string;
  runSyntax?: { supported: boolean; missingFlags: string[] };
  note?: string;
}

/** Structured error body returned by the backend ({ code, error, ... }). */
export interface ApiErrorBody {
  code?: string;
  error?: string;
  [k: string]: unknown;
}

/** Outcome of POST /api/missions/:id/start, kept per mission so the UI can explain a refusal. */
export interface StartOutcome {
  httpStatus: number;
  code?: string;
  error?: string;
  diagnostics?: BobDiagnostics;
  at: string;
}

export interface RollbackOutcome {
  ok: boolean;
  httpStatus: number;
  code?: string;
  error?: string;
  removed?: string[];
  restored?: string[];
  at: string;
}

// ─── WebSocket events (mirrors backend events.ts) ─────────────────────────────

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

export interface ForgeGuardEvent {
  type: ForgeGuardEventType;
  timestamp: string;
  missionId: string;
  payload: Record<string, unknown>;
}

// ─── Demo replay (deterministic fixtures; never a live Bob run) ───────────────

export interface ReplayScenario {
  id: string;
  title: string;
  purpose: string;
  expectedFinalState: string;
  steps: number;
  durationSeconds: number;
}

export type ReplayStatus = 'playing' | 'paused' | 'awaiting_approval' | 'finished';
export type ReplayAction = 'play' | 'pause' | 'restart' | 'next' | 'approve' | 'rollback' | 'speed';

export interface ReplayRollbackOutcome {
  ok: true;
  replay: true;
  httpStatus: number;
  at: string;
  removed: string[];
  restored: string[];
  wouldRestore: string[];
  wouldRemove: string[];
}

/** GET /api/replay/:id — a replay session, shaped like the live mission REST data. */
export interface ReplayView {
  replay: true;
  replayId: string;
  label: string;
  status: ReplayStatus;
  speed: 1 | 2 | 4;
  scenario: { id: string; title: string; purpose: string; expectedFinalState: string; transparencyNote: string | null };
  position: number;
  totalSteps: number;
  replayTime: number;
  durationSeconds: number;
  awaitingApproval: boolean;
  finished: boolean;
  steps: Array<{ index: number; t: number; label: string; done: boolean }>;
  mission: Mission;
  phases: PipelinePhase[];
  tasks: AgentTask[];
  evidence: EvidenceItem[];
  validationRuns: ValidationRun[];
  verdict: ReleaseVerdictResult;
  rollback: RollbackStatus;
  rollbackOutcome: ReplayRollbackOutcome | null;
}
