/**
 * Dashboard.tsx — The selected LIVE mission: wires the store and real mission API into
 * MissionView. Demo replays are rendered by ReplayWorkspace instead.
 */

import React, { useEffect } from 'react';
import { useStore } from '../store/store';
import { IN_PROGRESS } from '../lib/selectors';
import { MissionView } from './MissionView';
import { Button } from './ui';

const POLL_MS = 5000;

export function Dashboard(): React.ReactElement {
  const activeMissionId = useStore((s) => s.activeMissionId);
  const detail = useStore((s) => s.detail);
  const wsConnected = useStore((s) => s.wsConnected);
  const startOutcome = useStore((s) => (s.activeMissionId ? s.startOutcomes[s.activeMissionId] : undefined));
  const rollbackOutcome = useStore((s) => (s.activeMissionId ? s.rollbackOutcomes[s.activeMissionId] : undefined));
  const liveOutput = useStore((s) => s.liveOutput);
  const busy = useStore((s) => s.busy);
  const refreshActive = useStore((s) => s.refreshActive);
  const startMission = useStore((s) => s.startMission);
  const approveMission = useStore((s) => s.approveMission);
  const rollbackMission = useStore((s) => s.rollbackMission);
  const setEvidenceDrawerOpen = useStore((s) => s.setEvidenceDrawerOpen);

  const mission = detail.mission.data;
  const inProgress = !!mission && IN_PROGRESS.includes(mission.status);

  // Fallback polling only while something can change without us seeing it.
  useEffect(() => {
    if (!activeMissionId || (!inProgress && wsConnected)) return;
    const t = setInterval(() => { void refreshActive(); }, POLL_MS);
    return () => clearInterval(t);
  }, [activeMissionId, inProgress, wsConnected, refreshActive]);

  if (!activeMissionId) {
    return (
      <main className="flex-1 flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h1 className="text-lg font-semibold text-gray-100">ForgeGuard</h1>
          <p className="text-sm text-gray-400 mt-1">Select a mission or create a new one to see its pipeline, evidence and release decision.</p>
          <p className="text-sm text-gray-500 mt-3">To see the full workflow without IBM Bob, open <strong className="text-gray-300">Demo replay</strong> in the sidebar.</p>
        </div>
      </main>
    );
  }

  const retry = (): void => { void refreshActive(); };
  const actions = mission ? (
    <>
      {!inProgress && mission.status !== 'complete' && (
        <Button variant="primary" onClick={() => { void startMission(mission.id); }} disabled={busy.starting}
          title="Starts the real pipeline; the backend runs a Bob availability preflight first">
          {busy.starting ? 'Starting…' : mission.status === 'created' ? 'Run pipeline' : 'Re-run pipeline'}
        </Button>
      )}
      <Button onClick={() => setEvidenceDrawerOpen(true)}>
        Evidence ({detail.evidence.loaded ? detail.evidence.data.length : '…'})
      </Button>
      <Button onClick={retry} disabled={detail.mission.loading} title="Reload all mission data from the backend">Refresh</Button>
    </>
  ) : null;

  return (
    <MissionView
      detail={detail}
      headerActions={actions}
      startOutcome={startOutcome}
      rollbackOutcome={rollbackOutcome}
      liveOutput={liveOutput}
      busy={busy}
      onApprove={async () => {
        const r = await approveMission(activeMissionId);
        return r.ok ? { ok: true } : { ok: false, error: `${r.error.code ?? `HTTP ${r.status}`}: ${r.error.error ?? ''}` };
      }}
      onRollback={() => { void rollbackMission(activeMissionId); }}
      onRetry={retry}
      onOpenEvidence={() => setEvidenceDrawerOpen(true)}
    />
  );
}
