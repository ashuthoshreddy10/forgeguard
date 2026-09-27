/**
 * releaseVerdict.ts — Deterministic release verdict computed from stored validation evidence.
 *
 * The verdict is derived only from `validation_runs` rows (baseline vs. post-implementation)
 * and the implementation phase outcome. Bob's release report never changes it.
 * The full decision table is documented in docs/RELEASE_VERDICT.md.
 */

import type Database from 'better-sqlite3';

/** The validation policy: every command must have a baseline and a post-implementation result. */
export const REQUIRED_VALIDATION_COMMANDS: readonly string[] = [
  'npm run lint',
  'npm test',
  'npm run typecheck',
  'npm run build',
];

export type RunKind = 'baseline' | 'post';
export type ReleaseVerdict = 'ready' | 'conditional' | 'blocked';

/** A validation_runs row as read from the database (fields are unknown until checked). */
export interface ValidationRunRow {
  id?: unknown;
  run_kind?: unknown;
  command?: unknown;
  exit_code?: unknown;
  passed?: unknown;
  timed_out?: unknown;
  completed_at?: unknown;
}

export type CommandOutcome = 'pass' | 'fail' | 'timed_out' | 'missing';

export type CommandClassification =
  | 'pass'                   // passed in baseline and after implementation
  | 'fixed'                  // failed in baseline, passes after implementation
  | 'pass_without_baseline'  // passes after implementation, no usable baseline result
  | 'preexisting_failure'    // failed in baseline and still fails after implementation
  | 'regression'             // passed in baseline, fails after implementation
  | 'unclassified_failure'   // fails after implementation, no usable baseline result to compare with
  | 'timed_out'              // timed out after implementation
  | 'missing_post';          // no post-implementation result

export interface CommandVerdict {
  command: string;
  baseline: CommandOutcome;
  post: CommandOutcome;
  baselineExitCode: number | null;
  postExitCode: number | null;
  baselineRunId: string | null;
  postRunId: string | null;
  classification: CommandClassification;
}

export interface ReleaseVerdictInput {
  baseline: ValidationRunRow[];
  post: ValidationRunRow[];
  /** true = implementation phase completed, false = failed/skipped, null = unknown. */
  implementationSucceeded: boolean | null;
  requiredCommands?: readonly string[];
}

export interface ReleaseVerdictResult {
  /** null = no verdict: there is no (or no well-formed) evidence to base one on. */
  verdict: ReleaseVerdict | null;
  reasons: string[];
  commands: CommandVerdict[];
  requiredCommands: string[];
  implementationSucceeded: boolean | null;
}

interface CheckedRun {
  id: string | null;
  command: string;
  exitCode: number | null;
  outcome: 'pass' | 'fail' | 'timed_out';
}

function checkRuns(rows: ValidationRunRow[], kind: RunKind, problems: string[]): Map<string, CheckedRun> {
  const byCommand = new Map<string, CheckedRun>();
  rows.forEach((row, i) => {
    const where = `${kind} row ${i}${typeof row.id === 'string' ? ` (${row.id})` : ''}`;
    if (typeof row.command !== 'string' || row.command.trim() === '') {
      problems.push(`${where}: missing command`);
      return;
    }
    const label = `${where} "${row.command}"`;
    if (row.run_kind !== kind) {
      problems.push(`${label}: run_kind is ${JSON.stringify(row.run_kind)}, expected "${kind}"`);
      return;
    }
    if (typeof row.completed_at !== 'string' || row.completed_at === '') {
      problems.push(`${label}: run never completed`);
      return;
    }
    if (byCommand.has(row.command)) {
      problems.push(`${label}: duplicate ${kind} result for the same command`);
      return;
    }
    const id = typeof row.id === 'string' ? row.id : null;
    if (row.timed_out === 1 || row.timed_out === true) {
      if (row.exit_code !== null || !(row.passed === 0 || row.passed === false)) {
        problems.push(`${label}: timed-out run must have exit_code null and passed 0`);
        return;
      }
      byCommand.set(row.command, { id, command: row.command, exitCode: null, outcome: 'timed_out' });
      return;
    }
    if (!(row.timed_out === undefined || row.timed_out === 0 || row.timed_out === false)) {
      problems.push(`${label}: timed_out ${JSON.stringify(row.timed_out)} is not 0/1`);
      return;
    }
    if (typeof row.exit_code !== 'number' || !Number.isInteger(row.exit_code)) {
      problems.push(`${label}: exit_code ${JSON.stringify(row.exit_code)} is not an integer`);
      return;
    }
    let passed: boolean;
    if (row.passed === 1 || row.passed === true) passed = true;
    else if (row.passed === 0 || row.passed === false) passed = false;
    else {
      problems.push(`${label}: passed ${JSON.stringify(row.passed)} is not 0/1`);
      return;
    }
    if (passed !== (row.exit_code === 0)) {
      problems.push(`${label}: passed=${String(row.passed)} contradicts exit_code ${row.exit_code}`);
      return;
    }
    byCommand.set(row.command, { id, command: row.command, exitCode: row.exit_code, outcome: passed ? 'pass' : 'fail' });
  });
  return byCommand;
}

/** A timed-out baseline is not evidence of anything, so it counts as no baseline. */
function classify(b: CheckedRun | undefined, p: CheckedRun | undefined): CommandClassification {
  if (!p) return 'missing_post';
  if (p.outcome === 'timed_out') return 'timed_out';
  const usableBaseline = b && b.outcome !== 'timed_out' ? b : undefined;
  if (p.outcome === 'pass') {
    if (!usableBaseline) return 'pass_without_baseline';
    return usableBaseline.outcome === 'pass' ? 'pass' : 'fixed';
  }
  if (!usableBaseline) return 'unclassified_failure';
  return usableBaseline.outcome === 'pass' ? 'regression' : 'preexisting_failure';
}

function describe(c: CommandVerdict): string {
  const q = `"${c.command}"`;
  const noBaseline = c.baseline === 'timed_out' ? 'its baseline run timed out' : 'it has no baseline result';
  switch (c.classification) {
    case 'regression':
      return `${q} exited ${c.postExitCode} after implementation but passed in the baseline (regression)`;
    case 'unclassified_failure':
      return `${q} exited ${c.postExitCode} after implementation and ${noBaseline}, so it cannot be shown to be pre-existing`;
    case 'timed_out':
      return `${q} timed out after implementation and was killed; a timed-out command is not evidence of a passing build`;
    case 'missing_post':
      return `${q} has no post-implementation result`;
    case 'preexisting_failure':
      return `${q} failed before and after implementation (baseline exit ${c.baselineExitCode}, post exit ${c.postExitCode}): pre-existing failure, not a regression`;
    case 'pass_without_baseline':
      return `${q} passed after implementation but ${noBaseline}`;
    case 'fixed':
      return `${q} failed in the baseline (exit ${c.baselineExitCode}) and passes after implementation`;
    case 'pass':
      return `${q} passed in the baseline and after implementation`;
  }
}

/**
 * Compute the release verdict. Rules, in order:
 *  1. any malformed row                                   → no verdict (null)
 *  2. implementation failed or was skipped                → blocked
 *  3. zero validation rows                                → no verdict (null)
 *  4. any regression / unclassified failure / post timeout / missing post → blocked
 *  5. any pre-existing failure / missing baseline / unknown implementation outcome → conditional
 *  6. otherwise                                           → ready
 */
export function computeReleaseVerdict(input: ReleaseVerdictInput): ReleaseVerdictResult {
  const requiredCommands = [...(input.requiredCommands ?? REQUIRED_VALIDATION_COMMANDS)];
  const base = { requiredCommands, implementationSucceeded: input.implementationSucceeded };

  const problems: string[] = [];
  const baseline = checkRuns(input.baseline, 'baseline', problems);
  const post = checkRuns(input.post, 'post', problems);
  if (problems.length > 0) {
    return { ...base, verdict: null, commands: [], reasons: problems.map((p) => `Malformed validation data: ${p}`) };
  }

  const commands: CommandVerdict[] = requiredCommands.map((command) => {
    const b = baseline.get(command);
    const p = post.get(command);
    return {
      command,
      baseline: b ? b.outcome : 'missing',
      post: p ? p.outcome : 'missing',
      baselineExitCode: b?.exitCode ?? null,
      postExitCode: p?.exitCode ?? null,
      baselineRunId: b?.id ?? null,
      postRunId: p?.id ?? null,
      classification: classify(b, p),
    };
  });

  if (input.implementationSucceeded === false) {
    return { ...base, verdict: 'blocked', commands, reasons: ['Implementation did not succeed, so there is no change that can be released'] };
  }

  if (input.baseline.length === 0 && input.post.length === 0) {
    return { ...base, verdict: null, commands: [], reasons: ['No validation runs recorded: no evidence, no verdict'] };
  }

  const blocking = commands.filter((c) =>
    c.classification === 'regression' || c.classification === 'unclassified_failure' ||
    c.classification === 'timed_out' || c.classification === 'missing_post');
  if (blocking.length > 0) {
    return { ...base, verdict: 'blocked', commands, reasons: blocking.map(describe) };
  }

  const conditions = commands
    .filter((c) => c.classification === 'preexisting_failure' || c.classification === 'pass_without_baseline')
    .map(describe);
  if (input.implementationSucceeded === null) {
    conditions.push('The implementation phase outcome is not recorded');
  }
  if (conditions.length > 0) {
    return { ...base, verdict: 'conditional', commands, reasons: conditions };
  }

  return {
    ...base,
    verdict: 'ready',
    commands,
    reasons: [
      `All ${requiredCommands.length} required validation commands passed after implementation, with baseline evidence and no regressions`,
      ...commands.filter((c) => c.classification === 'fixed').map(describe),
    ],
  };
}

// ─── Bob's narrative vs. the deterministic verdict ────────────────────────────

export interface BobReconciliation {
  /** Bob's assessment normalised to the verdict vocabulary; null if unrecognised. */
  bobAssessment: ReleaseVerdict | null;
  agreesWithVerdict: boolean | null;
  discrepancy: string | null;
}

export function normaliseBobAssessment(value: unknown): ReleaseVerdict | null {
  if (value === 'ready' || value === 'conditional' || value === 'blocked') return value;
  if (value === 'not-ready') return 'blocked';
  return null;
}

/** Compare Bob's narrative assessment with the verdict. The verdict always stands. */
export function reconcileBobAssessment(verdict: ReleaseVerdict, bobValue: unknown): BobReconciliation {
  const bobAssessment = normaliseBobAssessment(bobValue);
  if (bobAssessment === null) {
    return {
      bobAssessment: null,
      agreesWithVerdict: null,
      discrepancy: `Bob's report has no recognised releaseReadiness (got ${JSON.stringify(bobValue)}); the deterministic verdict "${verdict}" is used`,
    };
  }
  if (bobAssessment === verdict) return { bobAssessment, agreesWithVerdict: true, discrepancy: null };
  return {
    bobAssessment,
    agreesWithVerdict: false,
    discrepancy: `Bob's narrative assessed "${bobAssessment}" but the deterministic verdict from validation evidence is "${verdict}"; the deterministic verdict is used`,
  };
}

// ─── Loading the evidence from the database ───────────────────────────────────

interface PhaseRow { id: string; status: string; rowid: number }

function latestPhase(db: Database.Database, missionId: string, phaseName: string, afterRowid = 0): PhaseRow | undefined {
  return db.prepare(`
    SELECT id, status, rowid FROM pipeline_phases
    WHERE mission_id = ? AND phase_name = ? AND rowid > ? ORDER BY rowid DESC LIMIT 1
  `).get(missionId, phaseName, afterRowid) as PhaseRow | undefined;
}

/**
 * Compute the verdict for a mission's latest run from its stored rows.
 * Baseline runs belong to the latest repo_understanding phase (the start of a run);
 * the implementation and validation phases are the ones that follow it, so rows
 * from earlier re-runs never mix in.
 */
export function loadReleaseVerdict(db: Database.Database, missionId: string): ReleaseVerdictResult {
  const start = latestPhase(db, missionId, 'repo_understanding');
  const impl = start ? latestPhase(db, missionId, 'implementation', start.rowid) : undefined;
  const validation = impl ? latestPhase(db, missionId, 'validation', impl.rowid) : undefined;

  let implementationSucceeded: boolean | null = null;
  if (impl?.status === 'completed') implementationSucceeded = true;
  else if (impl?.status === 'failed' || impl?.status === 'skipped') implementationSucceeded = false;

  const runsFor = (phaseId: string, kind: RunKind): ValidationRunRow[] =>
    db.prepare(`
      SELECT id, run_kind, command, exit_code, passed, timed_out, completed_at FROM validation_runs
      WHERE mission_id = ? AND phase_id = ? AND run_kind = ? ORDER BY rowid
    `).all(missionId, phaseId, kind) as ValidationRunRow[];

  const baseline = start ? runsFor(start.id, 'baseline') : [];
  const post = validation ? runsFor(validation.id, 'post') : [];

  return computeReleaseVerdict({ baseline, post, implementationSucceeded });
}
