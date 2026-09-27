/**
 * MissionView.tsx — Presentational rendering of one mission's backend state.
 * Used for live missions (Dashboard) and for demo replays (ReplayWorkspace); the data
 * source and the action handlers are supplied by the caller.
 */

import React, { useMemo } from 'react';
import type { MissionDetail, LiveOutput } from '../store/store';
import type { ReplayRollbackOutcome, RollbackOutcome, StartOutcome } from '../types';
import {
  bobUnavailableInfo, currentRunValidation, failureDetails, latestPhases, parseReleaseReport, redactPaths,
} from '../lib/selectors';
import { MissionHeader } from './MissionHeader';
import { PipelineStepper } from './PipelineStepper';
import { FailurePanel } from './FailurePanel';
import { BobUnavailablePanel } from './BobUnavailablePanel';
import { ChangePlanPanel } from './ChangePlanPanel';
import { BobAnalysis, DeterministicDecision } from './ReleasePanel';
import { RollbackPanel } from './RollbackPanel';
import { ValidationPanel } from './ValidationPanel';
import { AgentOutputPanel, ParallelAnalysisGrid } from './AgentPanels';
import { ExecutionTimeline } from './ExecutionTimeline';
import { Panel, StateMessage } from './ui';

function StartRefusal({ outcome }: { outcome: StartOutcome }): React.ReactElement {
  return (
    <div role="alert" data-testid="start-refusal">
      <Panel tone="warning" title="The pipeline was not started" subtitle={`HTTP ${outcome.httpStatus}${outcome.code ? ` · ${outcome.code}` : ''}`}>
        <p className="text-sm text-amber-100">{redactPaths(outcome.error ?? 'The backend refused to start this mission.')}</p>
      </Panel>
    </div>
  );
}

export interface MissionViewProps {
  detail: MissionDetail;
  headerActions?: React.ReactNode;
  /** Rendered above the mission header (e.g. replay banner and controls). */
  top?: React.ReactNode;
  startOutcome?: StartOutcome | undefined;
  rollbackOutcome?: RollbackOutcome | undefined;
  replayRollbackOutcome?: ReplayRollbackOutcome | null;
  transparencyNote?: string | null;
  liveOutput: LiveOutput[];
  busy: { approving: boolean; rollingBack: boolean };
  onApprove: () => Promise<{ ok: boolean; error?: string }>;
  onRollback: () => void;
  onRetry: () => void;
  onOpenEvidence: () => void;
}

export function MissionView(p: MissionViewProps): React.ReactElement {
  const { detail } = p;
  const mission = detail.mission.data;
  const latest = useMemo(() => latestPhases(detail.phases.data), [detail.phases.data]);
  const validation = useMemo(() => currentRunValidation(detail.validationRuns.data, latest), [detail.validationRuns.data, latest]);
  const narrative = useMemo(() => parseReleaseReport(mission?.release_report), [mission?.release_report]);

  if (!mission) {
    return (
      <main className="flex-1 p-8">
        {p.top}
        {detail.mission.error
          ? <StateMessage kind="error" onRetry={p.onRetry}>Could not load the mission: {detail.mission.error}</StateMessage>
          : <StateMessage kind="loading">Loading mission…</StateMessage>}
      </main>
    );
  }

  const bobDown = bobUnavailableInfo(mission, detail.evidence.data, p.startOutcome);
  const failure = bobDown ? null : failureDetails(mission, latest, detail.tasks.data);
  const refusal = p.startOutcome && p.startOutcome.httpStatus >= 400 && p.startOutcome.code !== 'BOB_UNAVAILABLE'
    && p.startOutcome.code !== 'REPO_NOT_ALLOWED' && p.startOutcome.code !== 'REPO_NOT_GIT' ? p.startOutcome : null;

  return (
    <main className="relative flex-1 flex flex-col min-w-0 md:h-screen md:overflow-clip">
      {p.top}
      <MissionHeader mission={mission} latest={latest} actions={p.headerActions} />
      <div className="relative flex-1 md:overflow-y-auto px-4 md:px-6 py-4 space-y-4">
        {refusal && <StartRefusal outcome={refusal} />}
        {bobDown && <BobUnavailablePanel info={bobDown} />}
        {failure && <FailurePanel failure={failure} onOpenEvidence={p.onOpenEvidence} />}
        {detail.phases.error && <StateMessage kind="error" onRetry={p.onRetry}>Failed to load phases: {detail.phases.error}</StateMessage>}

        <PipelineStepper latest={latest} />

        <ChangePlanPanel mission={mission} planPhase={latest['change_plan']} busy={p.busy.approving} onApprove={p.onApprove} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <DeterministicDecision verdict={detail.verdict.data} loading={detail.verdict.loading} error={detail.verdict.error}
            loaded={detail.verdict.loaded} onRetry={p.onRetry} />
          <BobAnalysis narrative={narrative} verdict={detail.verdict.data?.verdict ?? null} transparencyNote={p.transparencyNote ?? null} />
        </div>

        <RollbackPanel status={detail.rollback.data} loading={detail.rollback.loading} error={detail.rollback.error}
          loaded={detail.rollback.loaded} outcome={p.rollbackOutcome} replayOutcome={p.replayRollbackOutcome ?? null}
          busy={p.busy.rollingBack} onRollback={p.onRollback} onRetry={p.onRetry} />

        <ValidationPanel baseline={validation.baseline} post={validation.post} earlierRuns={validation.earlierRuns}
          loading={detail.validationRuns.loading} error={detail.validationRuns.error} loaded={detail.validationRuns.loaded} onRetry={p.onRetry} />

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <ParallelAnalysisGrid phase={latest['parallel_analysis']} tasks={detail.tasks.data} />
          <AgentOutputPanel tasks={detail.tasks.data} liveOutput={p.liveOutput} />
        </div>

        <ExecutionTimeline phases={detail.phases.data} tasks={detail.tasks.data} />
      </div>
    </main>
  );
}
