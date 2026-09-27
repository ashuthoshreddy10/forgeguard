/**
 * ReplayWorkspace.tsx — Deterministic demo replay: scenario selector, persistent replay
 * banner, playback controls, and the regular mission panels rendering fixture data.
 * Nothing here calls the live mission API or IBM Bob.
 */

import React, { useEffect, useState } from 'react';
import { useReplayStore } from '../../store/replayStore';
import { useStore, type MissionDetail } from '../../store/store';
import { DisplayProvider, REPLAY_DISPLAY } from '../../lib/display';
import type { ReplayView } from '../../types';
import { MissionView } from '../MissionView';
import { Badge, Button, StateMessage } from '../ui';

const loaded = <T,>(data: T) => ({ data, loading: false, error: null, loaded: true });

/** A replay session in the same shape the live panels consume. */
export function replayDetail(v: ReplayView): MissionDetail {
  return {
    missionId: v.mission.id,
    mission: loaded(v.mission),
    phases: loaded(v.phases),
    tasks: loaded(v.tasks),
    evidence: loaded(v.evidence),
    validationRuns: loaded(v.validationRuns),
    verdict: loaded(v.verdict),
    rollback: loaded(v.rollback),
  };
}

export function ReplayBanner(): React.ReactElement {
  return (
    <div role="note" data-testid="replay-banner"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 md:px-6 py-2 bg-amber-950/70 border-b border-amber-700 text-amber-100 text-xs">
      <strong className="tracking-widest">DEMO REPLAY — NOT A LIVE BOB RUN</strong>
      <span>IBM Bob not invoked</span>
      <span>No repository changes</span>
      <span>Deterministic fixture data</span>
    </div>
  );
}

const STATUS_LABEL: Record<string, { text: string; tone: 'info' | 'neutral' | 'warning' | 'success' }> = {
  playing: { text: 'Playing', tone: 'info' },
  paused: { text: 'Paused', tone: 'neutral' },
  awaiting_approval: { text: 'Waiting for approval', tone: 'warning' },
  finished: { text: 'Finished', tone: 'success' },
};

export function ReplayControls({ session }: { session: ReplayView }): React.ReactElement {
  const control = useReplayStore((s) => s.control);
  const exit = useReplayStore((s) => s.exit);
  const busy = useReplayStore((s) => s.busy);
  const controlError = useReplayStore((s) => s.controlError);
  const status = STATUS_LABEL[session.status] ?? { text: session.status, tone: 'neutral' as const };

  return (
    <div className="px-4 md:px-6 py-3 bg-surface-800 border-b border-surface-600" aria-label="Replay controls" data-testid="replay-controls">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm font-semibold text-gray-100">{session.scenario.title}</span>
        <span data-testid="replay-status"><Badge tone={status.tone}>{status.text}</Badge></span>
        <span className="text-xs text-gray-300 font-mono" data-testid="replay-time">
          REPLAY TIME T+{session.replayTime}s / T+{session.durationSeconds}s · step {session.position + 1} of {session.totalSteps}
        </span>
        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {session.status === 'playing'
            ? <Button onClick={() => { void control('pause'); }} disabled={busy}>Pause</Button>
            : <Button onClick={() => { void control('play'); }} disabled={busy || session.status !== 'paused'}>Play</Button>}
          <Button onClick={() => { void control('next'); }} disabled={busy || session.status === 'finished' || session.status === 'awaiting_approval'}>Skip to next</Button>
          <Button onClick={() => { void control('restart'); }} disabled={busy}>Restart</Button>
          <div role="group" aria-label="Playback speed" className="flex">
            {([1, 2, 4] as const).map((sp) => (
              <button key={sp} type="button" aria-pressed={session.speed === sp} onClick={() => { void control('speed', sp); }} disabled={busy}
                className={`px-2 py-1 text-xs border ${session.speed === sp ? 'bg-sky-700 border-sky-500 text-white' : 'bg-surface-700 border-surface-500 text-gray-300'} first:rounded-l last:rounded-r`}>
                {sp}x
              </button>
            ))}
          </div>
          <Button onClick={() => { void exit(); }} disabled={busy} title="Reset this replay and return to the scenario list">Exit replay</Button>
        </div>
      </div>
      {session.awaitingApproval && (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-amber-200" data-testid="replay-approval">
          The replay is waiting for plan approval, as the real pipeline would.
          <Button variant="success" onClick={() => { void control('approve'); }} disabled={busy}>Approve plan</Button>
        </div>
      )}
      {controlError && <p role="alert" className="mt-2 text-xs text-red-300">{controlError}</p>}
      <ol className="mt-3 flex flex-wrap gap-1" aria-label="Replay timeline">
        {session.steps.map((s) => (
          <li key={s.index} title={s.label} data-done={s.done}
            className={`text-[11px] px-1.5 py-0.5 rounded border ${s.index === session.position ? 'border-sky-400 text-sky-100 bg-sky-950' : s.done ? 'border-surface-500 text-gray-300' : 'border-surface-700 text-gray-500'}`}>
            T+{s.t}s {s.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ReplaySelector(): React.ReactElement {
  const scenarios = useReplayStore((s) => s.scenarios);
  const loadedScenarios = useReplayStore((s) => s.scenariosLoaded);
  const error = useReplayStore((s) => s.scenariosError);
  const start = useReplayStore((s) => s.start);
  const busy = useReplayStore((s) => s.busy);
  const controlError = useReplayStore((s) => s.controlError);
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = chosen ?? scenarios[0]?.id ?? null;

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto w-full" data-testid="replay-selector">
      <section className="rounded-lg border border-amber-700 bg-surface-800 p-5" aria-label="Demo replay">
        <h1 className="text-lg font-semibold tracking-wide text-gray-100">FORGEGUARD DEMO REPLAY</h1>
        <ul className="mt-2 text-sm text-gray-300 space-y-0.5">
          <li>Deterministic demonstration of the ForgeGuard workflow</li>
          <li>No live IBM Bob execution</li>
          <li>No repository changes, no commands executed</li>
        </ul>
        <p className="mt-2 text-xs text-gray-400">
          IBM Bob 2.0 was used to build ForgeGuard. Replay mode shows the workflow with fixture data because live Bob execution is not available here.
        </p>
      </section>

      <h2 className="mt-6 mb-2 text-sm font-semibold text-gray-200">Choose a scenario</h2>
      {error && <StateMessage kind="error">{error}</StateMessage>}
      {!loadedScenarios && <StateMessage kind="loading">Loading scenarios…</StateMessage>}
      <div role="radiogroup" aria-label="Replay scenarios" className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {scenarios.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={selected === s.id} onClick={() => setChosen(s.id)}
            data-testid={`scenario-${s.id}`}
            className={`text-left rounded-lg border p-4 bg-surface-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${selected === s.id ? 'border-sky-500' : 'border-surface-600 hover:border-surface-500'}`}>
            <p className="text-sm font-semibold text-gray-100">{s.title}</p>
            <p className="mt-1 text-xs text-gray-300">{s.purpose}</p>
            <p className="mt-3 text-[11px] uppercase tracking-wider text-gray-500">Expected final state</p>
            <p className="text-xs text-gray-200">{s.expectedFinalState}</p>
            <p className="mt-2 text-[11px] text-gray-500">{s.steps} steps · replay time T+{s.durationSeconds}s</p>
          </button>
        ))}
      </div>
      {controlError && <p role="alert" className="mt-3 text-xs text-red-300">{controlError}</p>}
      <div className="mt-4">
        <Button variant="primary" disabled={!selected || busy} onClick={() => { if (selected) void start(selected); }}>
          {busy ? 'Starting…' : 'START REPLAY'}
        </Button>
      </div>
    </div>
  );
}

const POLL_MS = 1500;

export function ReplayWorkspace(): React.ReactElement {
  const session = useReplayStore((s) => s.session);
  const loadScenarios = useReplayStore((s) => s.loadScenarios);
  const refresh = useReplayStore((s) => s.refresh);
  const control = useReplayStore((s) => s.control);
  const busy = useReplayStore((s) => s.busy);
  const setEvidenceDrawerOpen = useStore((s) => s.setEvidenceDrawerOpen);

  useEffect(() => { void loadScenarios(); }, [loadScenarios]);

  // WebSocket `replay.updated` events trigger refreshes; polling is the fallback while playing.
  const playing = session?.status === 'playing';
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(t);
  }, [playing, refresh]);

  if (!session) {
    return (
      <main className="relative flex-1 flex flex-col min-w-0 md:h-screen md:overflow-y-auto">
        <ReplayBanner />
        <ReplaySelector />
      </main>
    );
  }

  return (
    <DisplayProvider mode={REPLAY_DISPLAY}>
      <MissionView
        detail={replayDetail(session)}
        top={<><ReplayBanner /><ReplayControls session={session} /></>}
        headerActions={<Button onClick={() => setEvidenceDrawerOpen(true)}>Evidence ({session.evidence.length})</Button>}
        replayRollbackOutcome={session.rollbackOutcome}
        transparencyNote={session.scenario.transparencyNote}
        liveOutput={[]}
        busy={{ approving: busy, rollingBack: busy }}
        onApprove={() => control('approve')}
        onRollback={() => { void control('rollback'); }}
        onRetry={() => { void refresh(); }}
        onOpenEvidence={() => setEvidenceDrawerOpen(true)}
      />
    </DisplayProvider>
  );
}
