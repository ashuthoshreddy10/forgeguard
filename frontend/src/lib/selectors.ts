/**
 * selectors.ts — Pure functions that turn backend rows into display state.
 * They select and format backend data; they never compute verdicts or rollback decisions.
 */

import type {
  AgentTask, BobDiagnostics, EvidenceItem, EvidenceType, Mission, MissionStatus, PhaseName,
  PipelinePhase, StartOutcome, ValidationRun,
} from '../types';

export const PIPELINE_PHASES: Array<{ key: PhaseName; label: string }> = [
  { key: 'repo_understanding', label: 'Repo Understanding' },
  { key: 'parallel_analysis', label: 'Parallel Analysis' },
  { key: 'change_plan', label: 'Change Plan' },
  { key: 'implementation', label: 'Implementation' },
  { key: 'validation', label: 'Validation' },
  { key: 'release_report', label: 'Release Report' },
];

export function phaseLabel(name: string): string {
  return PIPELINE_PHASES.find((p) => p.key === name)?.label ?? name.replace(/_/g, ' ');
}

// ─── Phases ───────────────────────────────────────────────────────────────────

/**
 * The newest row for each phase. A re-run appends new rows, so the newest row (highest
 * backend `seq`, falling back to response order) is the current state — never the first.
 */
export function latestPhases(phases: PipelinePhase[]): Partial<Record<string, PipelinePhase>> {
  const out: Partial<Record<string, PipelinePhase>> = {};
  const rank: Record<string, number> = {};
  phases.forEach((p, index) => {
    const r = typeof p.seq === 'number' ? p.seq : index;
    const prev = rank[p.phase_name];
    if (prev === undefined || r >= prev) {
      out[p.phase_name] = p;
      rank[p.phase_name] = r;
    }
  });
  return out;
}

/** The failed prerequisite named in a skipped phase's error ("Blocked: phase "x" failed"). */
export function blockedBy(phase: PipelinePhase | undefined): string | null {
  if (!phase || phase.status !== 'skipped') return null;
  const m = /Blocked: phase "([a-z_]+)" failed/.exec(phase.error_message ?? '');
  return m?.[1] ?? null;
}

export function currentPhase(latest: Partial<Record<string, PipelinePhase>>): PipelinePhase | null {
  const ordered = PIPELINE_PHASES.map((p) => latest[p.key]).filter((p): p is PipelinePhase => !!p);
  return ordered.find((p) => p.status === 'running')
    ?? ordered.find((p) => p.status === 'failed')
    ?? [...ordered].reverse().find((p) => p.status === 'completed')
    ?? null;
}

// ─── Mission status ───────────────────────────────────────────────────────────

export type StatusCategory = 'pending' | 'running' | 'awaiting_approval' | 'complete' | 'failed' | 'rolled_back';

export function missionCategory(status: MissionStatus): StatusCategory {
  switch (status) {
    case 'created': return 'pending';
    case 'analyzing':
    case 'planning':
    case 'implementing':
    case 'validating': return 'running';
    case 'awaiting_approval': return 'awaiting_approval';
    case 'complete': return 'complete';
    case 'failed': return 'failed';
    case 'rolled_back': return 'rolled_back';
    default: return 'pending';
  }
}

export const IN_PROGRESS: MissionStatus[] = ['analyzing', 'planning', 'awaiting_approval', 'implementing', 'validating'];

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Shorten absolute filesystem paths to their last segment for display. */
export function redactPaths(text: string): string {
  return text
    .replace(/(^|[\s"'(=])[A-Za-z]:[\\/][^\s"'<>|)]*/g, (m, lead: string) => `${lead}…${basenameOf(m.slice(lead.length))}`)
    .replace(/(^|[\s"'(=])\/(?:[\w.@-]+\/)+[\w.@-]+/g, (m, lead: string) => `${lead}…${basenameOf(m.slice(lead.length))}`);
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return `/${parts[parts.length - 1] ?? ''}`;
}

export interface ErrorClassification {
  code: string;
  /** Bob error kind from the task diagnostics, e.g. bob_error, timeout, spawn_failed. */
  kind: string | null;
  reason: string;
}

/** Classify a backend error message using the codes the backend itself writes. */
export function classifyError(message: string | null | undefined): ErrorClassification {
  const text = (message ?? '').trim();
  const phaseStripped = text.replace(/^Phase "[a-z_]+" failed:\s*/, '');
  const kind = /\[([a-z_]+)\]/.exec(phaseStripped)?.[1] ?? null;
  let code = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(phaseStripped)?.[1] ?? null;
  if (!code) {
    if (/^Release blocked:/.test(phaseStripped)) code = 'RELEASE_BLOCKED';
    else if (/^No release verdict:/.test(phaseStripped)) code = 'NO_RELEASE_VERDICT';
    else if (/approval timed out/i.test(phaseStripped)) code = 'APPROVAL_TIMEOUT';
    else if (/^Mission was cancelled/.test(phaseStripped)) code = 'CANCELLED';
    else if (kind) code = 'BOB_TASK_FAILED';
    else code = text.startsWith('Phase "') ? 'PHASE_FAILED' : 'MISSION_FAILED';
  }
  return { code, kind, reason: redactPaths(phaseStripped || text) };
}

export interface FailureDetails {
  phase: string | null;
  phaseLabel: string | null;
  classification: ErrorClassification;
  missionMessage: string | null;
  taskType: string | null;
  taskId: string | null;
  taskStatus: string | null;
  timestamp: string | null;
}

/** Failure information assembled from the mission, its newest phase rows and agent tasks. */
export function failureDetails(
  mission: Mission, latest: Partial<Record<string, PipelinePhase>>, tasks: AgentTask[],
): FailureDetails | null {
  const failedPhase = PIPELINE_PHASES.map((p) => latest[p.key]).find((p) => p?.status === 'failed') ?? null;
  if (mission.status !== 'failed' && !failedPhase) return null;
  const failedTask = failedPhase
    ? tasks.filter((t) => t.phase_id === failedPhase.id && (t.status === 'failed' || t.status === 'timed_out')).at(-1) ?? null
    : null;
  const message = failedPhase?.error_message ?? mission.error_message ?? null;
  return {
    phase: failedPhase?.phase_name ?? null,
    phaseLabel: failedPhase ? phaseLabel(failedPhase.phase_name) : null,
    classification: classifyError(message ?? mission.error_message),
    missionMessage: mission.error_message ? redactPaths(mission.error_message) : null,
    taskType: failedTask?.task_type ?? null,
    taskId: failedTask?.id ?? null,
    taskStatus: failedTask?.status ?? null,
    timestamp: failedPhase?.completed_at ?? (mission.status === 'failed' ? mission.updated_at : null),
  };
}

// ─── Bob unavailable ──────────────────────────────────────────────────────────

function safeDiagnostics(raw: Record<string, unknown>): BobDiagnostics {
  const d: BobDiagnostics = {};
  if (typeof raw['provider'] === 'string') d.provider = raw['provider'];
  if (typeof raw['available'] === 'boolean') d.available = raw['available'];
  if (typeof raw['code'] === 'string') d.code = raw['code'];
  if (typeof raw['version'] === 'string') d.version = raw['version'];
  if (typeof raw['error'] === 'string') d.error = redactPaths(raw['error']);
  if (typeof raw['note'] === 'string') d.note = raw['note'];
  const rs = raw['runSyntax'] as { supported?: unknown; missingFlags?: unknown } | undefined;
  if (rs && typeof rs.supported === 'boolean') {
    d.runSyntax = { supported: rs.supported, missingFlags: Array.isArray(rs.missingFlags) ? rs.missingFlags.map(String) : [] };
  }
  return d;
}

export interface BobUnavailableInfo {
  source: 'start-response' | 'evidence';
  diagnostics: BobDiagnostics;
  at: string | null;
}

/**
 * Bob-unavailable state from the /start response, or — after a reload — from the
 * mission's failure message and its persisted preflight evidence.
 */
export function bobUnavailableInfo(
  mission: Mission, evidence: EvidenceItem[], start: StartOutcome | undefined,
): BobUnavailableInfo | null {
  if (start?.code === 'BOB_UNAVAILABLE') {
    return {
      source: 'start-response',
      diagnostics: safeDiagnostics({ ...(start.diagnostics ?? {}), code: 'BOB_UNAVAILABLE', error: start.diagnostics?.error ?? start.error }),
      at: start.at,
    };
  }
  if (mission.status !== 'failed' || !mission.error_message?.startsWith('BOB_UNAVAILABLE')) return null;
  const pre = [...evidence].reverse().find((e) => e.phase_name === 'preflight' && e.evidence_type === 'error');
  let raw: Record<string, unknown> = {};
  if (pre) {
    try { raw = JSON.parse(pre.content) as Record<string, unknown>; } catch { raw = {}; }
  }
  const diagnostics = safeDiagnostics({ ...raw, code: 'BOB_UNAVAILABLE' });
  if (!diagnostics.error) diagnostics.error = redactPaths(mission.error_message.replace(/^BOB_UNAVAILABLE:\s*/, ''));
  return { source: 'evidence', diagnostics, at: pre?.created_at ?? mission.updated_at };
}

// ─── Validation ───────────────────────────────────────────────────────────────

export type RunState = 'running' | 'passed' | 'failed' | 'timed_out';

export function runState(r: ValidationRun): RunState {
  if (!r.completed_at) return 'running';
  if (r.timed_out === 1) return 'timed_out';
  return r.passed === 1 ? 'passed' : 'failed';
}

/**
 * Validation rows of the mission's current run: baseline rows belong to the newest
 * repo_understanding phase, post rows to the newest validation phase.
 */
export function currentRunValidation(runs: ValidationRun[], latest: Partial<Record<string, PipelinePhase>>): {
  baseline: ValidationRun[]; post: ValidationRun[]; earlierRuns: number;
} {
  const baselinePhase = latest['repo_understanding']?.id;
  const postPhase = latest['validation']?.id;
  const baseline = runs.filter((r) => r.run_kind === 'baseline' && !!baselinePhase && r.phase_id === baselinePhase);
  const post = runs.filter((r) => r.run_kind === 'post' && !!postPhase && r.phase_id === postPhase);
  return { baseline, post, earlierRuns: runs.length - baseline.length - post.length };
}

// ─── Release report (Bob narrative) ───────────────────────────────────────────

export interface BobNarrative {
  bobAssessment: string | null;
  agreesWithVerdict: boolean | null;
  discrepancy: string | null;
  /** Verdict recorded next to the narrative when it was written (informational). */
  recordedVerdict: string | null;
  summary: string | null;
  recommendation: string | null;
  remainingRisks: string[];
  raw: Record<string, unknown>;
}

export function parseReleaseReport(json: string | null | undefined): BobNarrative | null {
  if (!json) return null;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  const narrative = (parsed['bobNarrative'] && typeof parsed['bobNarrative'] === 'object'
    ? parsed['bobNarrative'] : parsed) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const hasEnvelope = 'bobNarrative' in parsed;
  return {
    bobAssessment: str(hasEnvelope ? parsed['bobAssessment'] : narrative['releaseReadiness']),
    agreesWithVerdict: typeof parsed['agreesWithVerdict'] === 'boolean' ? parsed['agreesWithVerdict'] : null,
    discrepancy: str(parsed['discrepancy']),
    recordedVerdict: hasEnvelope ? str(parsed['verdict']) : null,
    summary: str(narrative['summary']),
    recommendation: str(narrative['recommendation']),
    remainingRisks: Array.isArray(narrative['remainingRisks']) ? narrative['remainingRisks'].map(String) : [],
    raw: narrative,
  };
}

// ─── Change plan ──────────────────────────────────────────────────────────────

export interface ChangePlan {
  summary?: string;
  riskLevel?: string;
  affectedFiles?: string[];
  steps?: Array<{ order?: number; file?: string; description?: string }>;
  testingRequired?: string[];
  securityNotes?: string[];
  rollbackPlan?: string;
}

export function parseChangePlan(json: string | null | undefined): ChangePlan | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as unknown;
    return p && typeof p === 'object' ? (p as ChangePlan) : null;
  } catch {
    return null;
  }
}

// ─── Evidence ─────────────────────────────────────────────────────────────────

export const EVIDENCE_GROUPS: Array<{ key: 'prompt' | 'response' | 'structured_output' | 'observation' | 'error' | 'other'; label: string }> = [
  { key: 'prompt', label: 'Prompts' },
  { key: 'response', label: 'Responses' },
  { key: 'structured_output', label: 'Structured output' },
  { key: 'observation', label: 'Observations' },
  { key: 'error', label: 'Errors' },
  { key: 'other', label: 'Other' },
];

export function evidenceGroupOf(type: EvidenceType): (typeof EVIDENCE_GROUPS)[number]['key'] {
  return type === 'prompt' || type === 'response' || type === 'structured_output' || type === 'observation' || type === 'error'
    ? type : 'other';
}

export function groupEvidence(evidence: EvidenceItem[]): Record<string, EvidenceItem[]> {
  const groups: Record<string, EvidenceItem[]> = {};
  for (const g of EVIDENCE_GROUPS) groups[g.key] = [];
  for (const e of evidence) groups[evidenceGroupOf(e.evidence_type)]!.push(e);
  return groups;
}

export interface AgentInfo {
  taskType: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  bobTaskId: string | null;
}

/** Agent details per ForgeGuard task ID; the Bob task ID comes from the task's diagnostic evidence. */
export function agentInfoByTask(tasks: AgentTask[], evidence: EvidenceItem[]): Record<string, AgentInfo> {
  const bobIds: Record<string, string> = {};
  for (const e of evidence) {
    if (!e.task_id || (e.evidence_type !== 'observation' && e.evidence_type !== 'error')) continue;
    try {
      const d = JSON.parse(e.content) as { forgeguardTaskId?: unknown; bobTaskId?: unknown };
      if (d.forgeguardTaskId === e.task_id && typeof d.bobTaskId === 'string') bobIds[e.task_id] = d.bobTaskId;
    } catch { /* not a diagnostic row */ }
  }
  const out: Record<string, AgentInfo> = {};
  for (const t of tasks) {
    out[t.id] = {
      taskType: t.task_type, status: t.status,
      startedAt: t.started_at ?? null, completedAt: t.completed_at ?? null,
      bobTaskId: bobIds[t.id] ?? null,
    };
  }
  return out;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Remove terminal colour/control sequences for display; the stored evidence keeps them. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function repoName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).at(-1) ?? repoPath;
}
