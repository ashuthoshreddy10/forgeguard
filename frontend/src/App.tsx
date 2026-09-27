import React, { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Dashboard } from './components/Dashboard';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { NewMissionModal } from './components/NewMissionModal';
import { ReplayWorkspace } from './components/replay/ReplayWorkspace';
import { useWebSocket } from './hooks/useWebSocket';
import { useStore } from './store/store';
import { useReplayStore } from './store/replayStore';
import { DisplayProvider, REPLAY_DISPLAY } from './lib/display';

export default function App(): React.ReactElement {
  const [showNewMission, setShowNewMission] = useState(false);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const loadMissions = useStore((s) => s.loadMissions);
  const loadBobHealth = useStore((s) => s.loadBobHealth);
  const createMission = useStore((s) => s.createMission);
  const drawerOpen = useStore((s) => s.isEvidenceDrawerOpen);
  const setDrawerOpen = useStore((s) => s.setEvidenceDrawerOpen);
  const evidence = useStore((s) => s.detail.evidence);
  const tasks = useStore((s) => s.detail.tasks.data);
  const refreshActive = useStore((s) => s.refreshActive);
  const replaySession = useReplayStore((s) => s.session);
  const rehydrateReplay = useReplayStore((s) => s.rehydrate);
  const refreshReplay = useReplayStore((s) => s.refresh);

  useWebSocket();

  useEffect(() => {
    void loadMissions();
    void loadBobHealth();
    // A replay in progress survives a page reload (the session lives in the backend).
    void rehydrateReplay().then((restored) => { if (restored) setView('replay'); });
  }, [loadMissions, loadBobHealth, rehydrateReplay, setView]);

  const inReplay = view === 'replay';
  const drawer = inReplay ? (
    <DisplayProvider mode={REPLAY_DISPLAY}>
      <EvidenceDrawer open={drawerOpen && !!replaySession} onClose={() => setDrawerOpen(false)}
        evidence={replaySession?.evidence ?? []} tasks={replaySession?.tasks ?? []}
        loading={false} error={null} onRetry={() => { void refreshReplay(); }} />
    </DisplayProvider>
  ) : (
    <EvidenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} evidence={evidence.data} tasks={tasks}
      loading={evidence.loading} error={evidence.error} onRetry={() => { void refreshActive(); }} />
  );

  return (
    <div className="relative flex flex-col md:flex-row min-h-screen md:h-screen md:overflow-clip bg-surface-900 text-gray-100">
      <Sidebar onNewMission={() => setShowNewMission(true)} />
      {inReplay ? <ReplayWorkspace /> : <Dashboard onNewMission={() => setShowNewMission(true)} />}
      {drawer}
      {showNewMission && <NewMissionModal onClose={() => setShowNewMission(false)} onSubmit={createMission} />}
    </div>
  );
}
