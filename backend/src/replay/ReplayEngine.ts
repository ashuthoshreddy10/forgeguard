/**
 * ReplayEngine.ts — Builds a replay view as a PURE function of (fixture, state).
 *
 * The view has the same shape as the live REST responses (mission, phases, tasks,
 * evidence, validation runs, verdict, rollback status), so the existing UI renders it.
 * The release verdict and the Bob/verdict discrepancy are computed by the SAME pure
 * functions the live backend uses (computeReleaseVerdict, reconcileBobAssessment);
 * only their inputs come from the fixture.
 *
 * This module must never import BobClient, MissionOrchestrator, the git modules,
 * child_process or the database (enforced by tests/replay.test.ts).
 */

import {
  REQUIRED_VALIDATION_COMMANDS,
  computeReleaseVerdict,
  reconcileBobAssessment,
  type ReleaseVerdictResult,
  type ValidationRunRow,
} from '../pipeline/releaseVerdict';
import {
  apiCompatPrompt, changePlanPrompt, codeImpactPrompt, docAnalystPrompt, implementationPrompt,
  releaseReportPrompt, repoUnderstandingPrompt, securityAnalystPrompt, testEngineerPrompt,
} from '../pipeline/prompts';
import type { ReplayFixture, ReplayPhase, ReplayState, SpecialistType } from './ReplayTypes';

export const REPLAY_LABEL = 'DEMO REPLAY — NOT A LIVE BOB RUN';
export const FIXTURE_TAG = '[REPLAY FIXTURE — not produced by IBM Bob]';
export const NOT_EXECUTED_TAG = '[REPLAY FIXTURE — command not executed; output is fixture data]';

const SPECIALISTS: SpecialistType[] = ['code_impact_analyst', 'test_engineer', 'security_analyst', 'api_compat_analyst', 'doc_analyst'];
const PHASE_TASKS: Record<ReplayPhase, string[]> = {
  repo_understanding: ['repo_understander'],
  parallel_analysis: SPECIALISTS,
  change_plan: ['plan_synthesizer'],
  implementation: ['implementer'],
  validation: [],
  release_report: ['release_engineer'],
};
const PHASE_STATUS: Partial<Record<ReplayPhase, string>> = {
  repo_understanding: 'analyzing', parallel_analysis: 'analyzing', change_plan: 'planning',
  implementation: 'implementing', validation: 'validating',
};
const PHASE_ORDER: ReplayPhase[] = ['repo_understanding', 'parallel_analysis', 'change_plan', 'implementation', 'validation', 'release_report'];

/** Replay time → deterministic timestamp (the UI renders it as "T+Ns"). */
export const replayTimestamp = (seconds: number, extraMs = 0): string => new Date(seconds * 1000 + extraMs).toISOString();

export interface ReplayPhaseRow {
  seq: number; id: string; mission_id: string; phase_name: ReplayPhase; status: string;
  started_at: string | null; completed_at: string | null; error_message: string | null; output: string | null;
}
export interface ReplayTaskRow {
  seq: number; id: string; phase_id: string; mission_id: string; task_type: string; status: string;
  bob_provider: 'replay'; bob_mode: string; workspace: string; started_at: string | null; completed_at: string | null;
  duration_ms: number | null; error_message: string | null;
}
export interface ReplayEvidenceRow {
  seq: number; id: string; mission_id: string; task_id: string | null; phase_name: string;
  evidence_type: 'prompt' | 'response' | 'structured_output' | 'observation' | 'error'; content: string; created_at: string;
  replay: true;
}
export interface ReplayRunRow {
  seq: number; id: string; mission_id: string; phase_id: string; run_kind: 'baseline' | 'post'; command: string;
  exit_code: number; timed_out: 0; stdout: string; stderr: string; passed: 0 | 1;
  started_at: string; completed_at: string; duration_ms: number; replay: true;
}

export interface ReplayView {
  replay: true;
  label: typeof REPLAY_LABEL;
  scenario: { id: string; title: string; purpose: string; expectedFinalState: string; transparencyNote: string | null };
  position: number;
  totalSteps: number;
  replayTime: number;
  durationSeconds: number;
  awaitingApproval: boolean;
  finished: boolean;
  steps: Array<{ index: number; t: number; label: string; done: boolean }>;
  mission: {
    id: string; created_at: string; updated_at: string; status: string; issue_text: string; repo_path: string;
    plan_approved: 0 | 1; repo_summary: string | null; change_plan: string | null; validation_result: string | null;
    release_report: string | null; rollback_ref: string | null; error_message: string | null;
  };
  phases: ReplayPhaseRow[];
  tasks: ReplayTaskRow[];
  evidence: ReplayEvidenceRow[];
  validationRuns: ReplayRunRow[];
  verdict: ReleaseVerdictResult;
  rollback: { available: boolean; code?: string; reason?: string; anchorRef: string | null; replay: true };
  rollbackOutcome: { ok: true; replay: true; httpStatus: 200; at: string; removed: string[]; restored: string[]; wouldRestore: string[]; wouldRemove: string[] } | null;
}

const pad = (n: number): string => String(n).padStart(3, '0');

/** Index of the approval gate step, or -1. */
export function approvalGateIndex(fixture: ReplayFixture): number {
  return fixture.timeline.findIndex((s) => s.action.type === 'approval_required');
}

/** Structural checks on a fixture (run by tests and at load time). Returns problems. */
export function validateFixture(fixture: ReplayFixture): string[] {
  const problems: string[] = [];
  const tl = fixture.timeline;
  if (tl.length === 0 || tl[0]!.action.type !== 'mission_created') problems.push('timeline must start with mission_created');
  tl.forEach((s, i) => { if (i > 0 && s.t < tl[i - 1]!.t) problems.push(`step ${i} goes back in time`); });
  const gate = approvalGateIndex(fixture);
  if (gate < 0 || tl[gate + 1]?.action.type !== 'approved') problems.push('approval_required must be followed by approved');
  for (const cmd of REQUIRED_VALIDATION_COMMANDS) {
    if (!fixture.validation.baseline[cmd]) problems.push(`baseline missing ${cmd}`);
    if (!fixture.validation.post[cmd]) problems.push(`post missing ${cmd}`);
  }
  if (!/^[a-z0-9-]+$/.test(fixture.id)) problems.push('invalid scenario id');
  // Live-reachability: a Bob narrative only exists if Phase 6 completes, which never follows a blocked verdict.
  const hasPhase6 = tl.some((s) => s.action.type === 'phase_completed' && s.action.phase === 'release_report');
  if (fixture.bobNarrative && !hasPhase6) problems.push('bobNarrative requires a completed release_report phase');
  if (fixture.bobNarrative && fixture.expectedVerdict === 'blocked') problems.push('a blocked scenario cannot have a Bob narrative (Phase 6 does not run)');
  return problems;
}

export function buildReplayView(fixture: ReplayFixture, state: ReplayState): ReplayView {
  const missionId = `replay-mission-${fixture.id}`;
  const repoPath = `replay://${fixture.mission.repoLabel}`;
  const issue = fixture.mission.issueText;
  let seq = 0;
  const ids = { phase: 0, task: 0, evidence: 0, run: 0 };
  const nextId = (kind: keyof typeof ids): string => `replay-${kind}-${pad(++ids[kind])}`;

  const mission: ReplayView['mission'] = {
    id: missionId, created_at: replayTimestamp(0), updated_at: replayTimestamp(0), status: 'created', issue_text: issue,
    repo_path: repoPath, plan_approved: 0, repo_summary: null, change_plan: null, validation_result: null,
    release_report: null, rollback_ref: null, error_message: null,
  };
  const phases: ReplayPhaseRow[] = [];
  const tasks: ReplayTaskRow[] = [];
  const evidence: ReplayEvidenceRow[] = [];
  const runs: ReplayRunRow[] = [];
  let verdict: ReleaseVerdictResult | null = null;

  const latestPhase = (name: ReplayPhase): ReplayPhaseRow | undefined => [...phases].reverse().find((p) => p.phase_name === name);
  const addEvidence = (t: number, phaseName: string, type: ReplayEvidenceRow['evidence_type'], content: string, taskId: string | null = null): void => {
    evidence.push({ seq: ++seq, id: nextId('evidence'), mission_id: missionId, task_id: taskId, phase_name: phaseName, evidence_type: type, content, created_at: replayTimestamp(t), replay: true });
  };
  const repoSummaryJson = JSON.stringify(fixture.repoSummary);
  const specialistSummary = (): string => SPECIALISTS.map((s) => `=== ${s} ===\n${JSON.stringify(fixture.specialists[s])}`).join('\n\n');
  const promptFor = (taskType: string): string => {
    switch (taskType) {
      case 'repo_understander': return repoUnderstandingPrompt(issue, fixture.mission.repoLabel);
      case 'code_impact_analyst': return codeImpactPrompt(issue, repoSummaryJson);
      case 'test_engineer': return testEngineerPrompt(issue, repoSummaryJson);
      case 'security_analyst': return securityAnalystPrompt(issue, repoSummaryJson);
      case 'api_compat_analyst': return apiCompatPrompt(issue, repoSummaryJson);
      case 'doc_analyst': return docAnalystPrompt(issue, repoSummaryJson);
      case 'plan_synthesizer': return changePlanPrompt(issue, specialistSummary());
      case 'implementer': return implementationPrompt(issue, JSON.stringify(fixture.changePlan));
      case 'release_engineer': return releaseReportPrompt(issue, '(replay fixture validation evidence)', verdict?.verdict ?? 'none');
      default: return '';
    }
  };
  const outputFor = (taskType: string): unknown => {
    if (taskType === 'repo_understander') return fixture.repoSummary;
    if ((SPECIALISTS as string[]).includes(taskType)) return fixture.specialists[taskType as SpecialistType];
    if (taskType === 'plan_synthesizer') return fixture.changePlan;
    if (taskType === 'implementer') return fixture.implementation;
    if (taskType === 'release_engineer') return fixture.bobNarrative;
    return null;
  };
  const runRows = (kind: 'baseline' | 'post'): ValidationRunRow[] =>
    runs.filter((r) => r.run_kind === kind).map((r) => ({ id: r.id, run_kind: r.run_kind, command: r.command, exit_code: r.exit_code, passed: r.passed, timed_out: 0, completed_at: r.completed_at }));

  const addRuns = (t: number, kind: 'baseline' | 'post', phaseId: string): void => {
    let offset = 0;
    for (const command of REQUIRED_VALIDATION_COMMANDS) {
      const f = fixture.validation[kind][command]!;
      runs.push({
        seq: ++seq, id: nextId('run'), mission_id: missionId, phase_id: phaseId, run_kind: kind, command,
        exit_code: f.exitCode, timed_out: 0, stdout: `${NOT_EXECUTED_TAG}\n${f.stdout}`, stderr: f.stderr ?? '',
        passed: f.exitCode === 0 ? 1 : 0, started_at: replayTimestamp(t, offset), completed_at: replayTimestamp(t, offset + f.durationMs),
        duration_ms: f.durationMs, replay: true,
      });
      offset += f.durationMs;
    }
    const lines = REQUIRED_VALIDATION_COMMANDS.map((c) => `  ${c}: exit ${fixture.validation[kind][c]!.exitCode}`).join('\n');
    addEvidence(t, kind === 'baseline' ? 'baseline_validation' : 'validation', 'observation',
      `${FIXTURE_TAG}\n${kind === 'baseline' ? 'Baseline' : 'Post-implementation'} validation results from the replay fixture (no command was executed):\n${lines}`);
  };

  const attachNarrative = (t: number, taskId: string | null): void => {
    if (!fixture.bobNarrative || !verdict?.verdict) return;
    const reconciliation = reconcileBobAssessment(verdict.verdict, fixture.bobNarrative.releaseReadiness);
    mission.release_report = JSON.stringify({
      verdict: verdict.verdict,
      verdictSource: 'deterministic (computeReleaseVerdict over replay fixture validation rows)',
      verdictReasons: verdict.reasons,
      bobAssessment: reconciliation.bobAssessment,
      agreesWithVerdict: reconciliation.agreesWithVerdict,
      discrepancy: reconciliation.discrepancy,
      bobNarrative: { ...fixture.bobNarrative, replayFixture: true, label: 'REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE' },
    });
    if (reconciliation.discrepancy) {
      addEvidence(t, 'release_report', 'observation', `${FIXTURE_TAG}\nVerdict discrepancy: ${reconciliation.discrepancy}`, taskId);
    }
  };

  const steps = fixture.timeline;
  const last = Math.min(state.position, steps.length - 1);
  for (let i = 0; i <= last; i++) {
    const { t, action } = steps[i]!;
    mission.updated_at = replayTimestamp(t);
    switch (action.type) {
      case 'mission_created':
        mission.created_at = replayTimestamp(t);
        addEvidence(t, 'replay', 'observation',
          `${REPLAY_LABEL}\nScenario "${fixture.title}". IBM Bob is not invoked, no command is executed and the repository is not modified; every value comes from the replay fixture.`);
        break;
      case 'phase_started': {
        const status = PHASE_STATUS[action.phase];
        if (status) mission.status = status;
        const phase: ReplayPhaseRow = {
          seq: ++seq, id: nextId('phase'), mission_id: missionId, phase_name: action.phase, status: 'running',
          started_at: replayTimestamp(t), completed_at: null, error_message: null, output: null,
        };
        phases.push(phase);
        if (action.phase === 'implementation' && fixture.rollback.anchorAvailable) {
          mission.rollback_ref = 'replay-anchor-001';
          addEvidence(t, 'implementation', 'observation', `${FIXTURE_TAG}\n${JSON.stringify({
            event: 'rollback_anchor_created', replay: true, ref: 'replay-anchor-001',
            note: 'Replay fixture: no Git ref was created and the repository was not touched.',
          }, null, 2)}`);
        }
        for (const taskType of PHASE_TASKS[action.phase]) {
          const task: ReplayTaskRow = {
            seq: ++seq, id: nextId('task'), phase_id: phase.id, mission_id: missionId, task_type: taskType, status: 'running',
            bob_provider: 'replay', bob_mode: taskType === 'implementer' ? 'agent' : taskType === 'plan_synthesizer' || taskType === 'release_engineer' ? 'plan' : 'ask',
            workspace: repoPath, started_at: replayTimestamp(t), completed_at: null, duration_ms: null, error_message: null,
          };
          tasks.push(task);
          addEvidence(t, action.phase, 'prompt',
            `${FIXTURE_TAG}\nThe prompt ForgeGuard's template produces for this task. In replay it is NOT sent to IBM Bob.\n\n${promptFor(taskType)}`, task.id);
        }
        break;
      }
      case 'baseline_validation': {
        const p1 = latestPhase('repo_understanding');
        if (p1) addRuns(t, 'baseline', p1.id);
        break;
      }
      case 'post_validation': {
        const p5 = latestPhase('validation');
        if (p5) addRuns(t, 'post', p5.id);
        break;
      }
      case 'phase_completed': {
        const phase = latestPhase(action.phase);
        if (!phase) break;
        phase.status = 'completed';
        phase.completed_at = replayTimestamp(t);
        for (const task of tasks.filter((x) => x.phase_id === phase.id)) {
          task.status = 'completed';
          task.completed_at = replayTimestamp(t);
          task.duration_ms = (t - Date.parse(task.started_at!) / 1000) * 1000;
          const out = outputFor(task.task_type);
          if (task.task_type === 'implementer') {
            addEvidence(t, action.phase, 'response', `${FIXTURE_TAG}\n${fixture.implementation.summary}\n\nChanged files (fixture):\n${fixture.implementation.changedFiles.map((f) => `  ${f.change} ${f.path}`).join('\n')}`, task.id);
          } else if (out) {
            addEvidence(t, action.phase, 'structured_output', `${FIXTURE_TAG}\n${JSON.stringify(out, null, 2)}`, task.id);
          }
          addEvidence(t, action.phase, 'observation', JSON.stringify({
            provider: 'replay', forgeguardTaskId: task.id, bobTaskId: null, success: true, replayFixture: true,
            note: 'Replay fixture: IBM Bob was not invoked for this task.',
          }, null, 2), task.id);
        }
        if (action.phase === 'repo_understanding') mission.repo_summary = repoSummaryJson;
        if (action.phase === 'change_plan') mission.change_plan = JSON.stringify(fixture.changePlan);
        if (action.phase === 'release_report') attachNarrative(t, tasks.filter((x) => x.task_type === 'release_engineer').at(-1)?.id ?? null);
        break;
      }
      case 'approval_required':
        mission.status = 'awaiting_approval';
        break;
      case 'approved':
        mission.plan_approved = 1;
        addEvidence(t, 'change_plan', 'observation', `${FIXTURE_TAG}\nChange plan approved by the viewer in replay mode.`);
        break;
      case 'release_decision': {
        const impl = latestPhase('implementation');
        verdict = computeReleaseVerdict({
          baseline: runRows('baseline'),
          post: runRows('post'),
          implementationSucceeded: impl?.status === 'completed' ? true : impl ? false : null,
        });
        const p5 = latestPhase('validation');
        mission.validation_result = JSON.stringify({ releaseVerdict: verdict, post: runs.filter((r) => r.run_kind === 'post') });
        addEvidence(t, 'validation', 'observation',
          `Deterministic release verdict: ${verdict.verdict ?? 'none'} (computed by ForgeGuard's release-verdict logic over replay fixture rows)\n${JSON.stringify(verdict, null, 2)}`);
        if (verdict.verdict === 'blocked' || verdict.verdict === null) {
          const reason = verdict.verdict === 'blocked' ? `Release blocked: ${verdict.reasons.join('; ')}` : `No release verdict: ${verdict.reasons.join('; ')}`;
          if (p5) { p5.status = 'failed'; p5.completed_at = replayTimestamp(t); p5.error_message = reason; }
          for (const name of PHASE_ORDER.slice(PHASE_ORDER.indexOf('validation') + 1)) {
            phases.push({
              seq: ++seq, id: nextId('phase'), mission_id: missionId, phase_name: name, status: 'skipped',
              started_at: null, completed_at: replayTimestamp(t), error_message: 'Blocked: phase "validation" failed', output: null,
            });
          }
          mission.status = 'failed';
          mission.error_message = `Phase "validation" failed: ${reason}`;
          // As in the live pipeline, Phase 6 (and so any Bob narrative) never follows a blocked verdict.
        } else if (p5) {
          p5.status = 'completed';
          p5.completed_at = replayTimestamp(t);
        }
        break;
      }
      case 'mission_completed':
        mission.status = 'complete';
        break;
    }
  }

  const finished = last >= steps.length - 1;
  const lastT = steps[last]?.t ?? 0;
  const durationSeconds = steps.at(-1)?.t ?? 0;
  const terminal = mission.status === 'complete' || mission.status === 'failed';
  let rollbackOutcome: ReplayView['rollbackOutcome'] = null;
  if (state.rolledBack && finished && terminal && fixture.rollback.anchorAvailable) {
    mission.status = 'rolled_back';
    mission.updated_at = replayTimestamp(lastT + 1);
    rollbackOutcome = {
      ok: true, replay: true, httpStatus: 200, at: replayTimestamp(lastT + 1), removed: [], restored: [],
      wouldRestore: fixture.rollback.wouldRestore, wouldRemove: fixture.rollback.wouldRemove,
    };
    addEvidence(lastT + 1, 'rollback', 'observation', `DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK\n${JSON.stringify({
      event: 'replay_rollback', replay: true, filesChanged: 0,
      fixtureDescribes: { wouldRestore: fixture.rollback.wouldRestore, wouldRemove: fixture.rollback.wouldRemove },
      note: 'No file was restored or removed. A real rollback would restore the anchor state shown above.',
    }, null, 2)}`);
  }

  let rollback: ReplayView['rollback'];
  if (mission.status === 'rolled_back') {
    rollback = { available: false, code: 'ROLLBACK_ALREADY_DONE', reason: 'This replay mission has already been rolled back (replay only; no files changed)', anchorRef: mission.rollback_ref, replay: true };
  } else if (!terminal) {
    rollback = { available: false, code: 'ROLLBACK_NOT_ALLOWED', reason: `Rollback is not allowed while the mission is "${mission.status}"`, anchorRef: mission.rollback_ref, replay: true };
  } else if (!mission.rollback_ref) {
    rollback = { available: false, code: 'NO_ROLLBACK_ANCHOR', reason: 'This mission has no rollback anchor (implementation never started)', anchorRef: null, replay: true };
  } else {
    rollback = { available: true, anchorRef: `${mission.rollback_ref} (replay fixture; no Git ref exists)`, replay: true };
  }

  return {
    replay: true,
    label: REPLAY_LABEL,
    scenario: { id: fixture.id, title: fixture.title, purpose: fixture.purpose, expectedFinalState: fixture.expectedFinalState, transparencyNote: fixture.transparencyNote ?? null },
    position: last,
    totalSteps: steps.length,
    replayTime: state.rolledBack && rollbackOutcome ? lastT + 1 : lastT,
    durationSeconds,
    awaitingApproval: steps[last]?.action.type === 'approval_required' && !state.approved,
    finished,
    steps: steps.map((s, i) => ({ index: i, t: s.t, label: s.label, done: i <= last })),
    mission,
    phases,
    tasks,
    evidence,
    validationRuns: runs,
    verdict: verdict ?? {
      verdict: null,
      reasons: ['No release verdict yet: it is computed at the release-decision step, after post-implementation validation.'],
      commands: [], requiredCommands: [...REQUIRED_VALIDATION_COMMANDS], implementationSucceeded: null,
    },
    rollback,
    rollbackOutcome,
  };
}
