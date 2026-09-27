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

const FLOW = ['Analysis', 'Plan', 'Implementation', 'Validation', 'Release decision'];
const CTA = 'font-semibold tracking-wide rounded border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-900';

function Welcome({ onStartReplay, onNewMission }: { onStartReplay: () => void; onNewMission: (() => void) | undefined }): React.ReactElement {
  return (
    <main className="flex-1 flex items-center justify-center px-4 py-10 md:p-8" data-testid="welcome">
      <div className="text-center max-w-xl w-full">
        <h1 className="text-2xl font-bold tracking-tight text-sky-300 font-mono">ForgeGuard</h1>
        <p className="text-sm text-gray-300 mt-1">Evidence-based software change validation</p>

        <p className="text-sm text-gray-400 mt-6">See how ForgeGuard takes a software change from</p>
        <ol aria-label="ForgeGuard workflow" className="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] font-mono uppercase tracking-wider text-gray-200">
          {FLOW.map((step, i) => (
            <li key={step} className="flex items-center gap-1.5">
              <span className="px-2 py-0.5 rounded border border-surface-500 bg-surface-800">{step}</span>
              {i < FLOW.length - 1 && <span aria-hidden className="text-gray-500">→</span>}
            </li>
          ))}
        </ol>

        <div className="mt-8 flex flex-col items-center">
          <button type="button" onClick={onStartReplay} className={`${CTA} px-6 py-2.5 text-sm bg-sky-600 hover:bg-sky-500 text-white border-sky-500`}>
            START DEMO REPLAY
          </button>
          <p className="mt-2 text-xs text-gray-400">Deterministic demonstration — no live IBM Bob execution and no repository changes.</p>
          {onNewMission && (
            <button type="button" onClick={onNewMission}
              className={`${CTA} mt-5 px-4 py-2 text-xs bg-surface-800 hover:bg-surface-700 text-gray-200 border-surface-500`}>
              CREATE LIVE MISSION
            </button>
          )}
        </div>

        <ul aria-label="Capabilities" className="mt-10 flex justify-center gap-6 text-[11px] font-mono tracking-[0.2em] text-gray-400">
          <li>ANALYZE</li><li>VALIDATE</li><li>DECIDE</li>
        </ul>
        <p className="mt-2 text-xs text-gray-500">AI recommends. Evidence decides.</p>
      </div>
    </main>
  );
}

export function Dashboard({ onNewMission }: { onNewMission?: () => void } = {}): React.ReactElement {
  const activeMissionId = useStore((s) => s.activeMissionId);
  const setView = useStore((s) => s.setView);
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
    return <Welcome onStartReplay={() => setView('replay')} onNewMission={onNewMission} />;
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
