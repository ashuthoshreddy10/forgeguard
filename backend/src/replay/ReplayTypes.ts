/**
 * ReplayTypes.ts — Types for deterministic demo replay (docs/DEMO_REPLAY.md).
 * Replay data is fixture-driven and never produced by IBM Bob, npm or git.
 */

export type SpecialistType =
  | 'code_impact_analyst' | 'test_engineer' | 'security_analyst' | 'api_compat_analyst' | 'doc_analyst';

export type ReplayPhase =
  | 'repo_understanding' | 'parallel_analysis' | 'change_plan' | 'implementation' | 'validation' | 'release_report';

export interface FixtureRun {
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr?: string;
}

/** One deterministic step of the replay timeline. `t` is replay time in seconds. */
export type ReplayAction =
  | { type: 'mission_created' }
  | { type: 'phase_started'; phase: ReplayPhase }
  | { type: 'baseline_validation' }
  | { type: 'phase_completed'; phase: ReplayPhase }
  | { type: 'approval_required' }
  | { type: 'approved' }
  | { type: 'post_validation' }
  | { type: 'release_decision' }
  | { type: 'mission_completed' };

export interface ReplayStep {
  t: number;
  label: string;
  action: ReplayAction;
}

export interface ReplayFixture {
  id: string;
  title: string;
  purpose: string;
  expectedFinalState: string;
  /** Sanity value checked by tests against the verdict the real logic computes; never displayed. */
  expectedVerdict: 'ready' | 'conditional' | 'blocked';
  /** Scenario-specific transparency note shown in the UI. */
  transparencyNote?: string;
  mission: { issueText: string; repoLabel: string };
  repoSummary: Record<string, unknown>;
  specialists: Record<SpecialistType, Record<string, unknown>>;
  changePlan: {
    summary: string;
    riskLevel: string;
    affectedFiles: string[];
    steps: Array<{ order: number; file: string; description: string }>;
    testingRequired: string[];
    securityNotes: string[];
    rollbackPlan: string;
  };
  implementation: { summary: string; changedFiles: Array<{ path: string; change: 'added' | 'modified' | 'deleted' }> };
  validation: { baseline: Record<string, FixtureRun>; post: Record<string, FixtureRun> };
  /** Synthetic Bob narrative (Phase 6 style). Null = no narrative in this scenario. */
  bobNarrative: {
    releaseReadiness: string;
    summary: string;
    recommendation: string;
    remainingRisks: string[];
  } | null;
  rollback: { anchorAvailable: boolean; wouldRestore: string[]; wouldRemove: string[] };
  timeline: ReplayStep[];
}

export type ReplayStatus = 'playing' | 'paused' | 'awaiting_approval' | 'finished';
export type ReplaySpeed = 1 | 2 | 4;

/** Everything that determines a replay view. The view is a pure function of (fixture, state). */
export interface ReplayState {
  position: number;
  approved: boolean;
  rolledBack: boolean;
}

export interface ReplayScenarioSummary {
  id: string;
  title: string;
  purpose: string;
  expectedFinalState: string;
  steps: number;
  durationSeconds: number;
}
