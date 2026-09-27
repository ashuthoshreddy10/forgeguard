/**
 * Sidebar.tsx — Mission list, connection state and Bob availability.
 */

import React from 'react';
import { useStore } from '../store/store';
import { formatTime } from '../lib/selectors';
import { Badge, StateMessage, StatusBadge } from './ui';

export function Sidebar({ onNewMission }: { onNewMission: () => void }): React.ReactElement {
  const missions = useStore((s) => s.missions);
  const activeMissionId = useStore((s) => s.activeMissionId);
  const selectMission = useStore((s) => s.selectMission);
  const loadMissions = useStore((s) => s.loadMissions);
  const wsConnected = useStore((s) => s.wsConnected);
  const bob = useStore((s) => s.bobHealth);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);

  return (
    <aside className="w-full md:w-72 flex-shrink-0 bg-surface-800 border-b md:border-b-0 md:border-r border-surface-600 flex flex-col md:h-screen" aria-label="Missions">
      <div className="px-4 py-4 border-b border-surface-600">
        <p className="text-sky-300 font-bold text-lg tracking-tight font-mono">ForgeGuard</p>
        <p className="text-xs text-gray-400">Evidence-based change validation</p>
      </div>
      <div className="px-3 py-3 border-b border-surface-600">
        <button type="button" onClick={onNewMission}
          className="w-full px-3 py-2 bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-300">
          + New mission
        </button>
        <button type="button" onClick={() => setView('replay')} aria-current={view === 'replay' ? 'true' : undefined}
          data-testid="open-replay"
          className={`mt-2 w-full px-3 py-2 text-sm font-medium rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 ${view === 'replay' ? 'bg-amber-900/60 border-amber-600 text-amber-100' : 'bg-surface-700 border-amber-800 text-amber-200 hover:bg-surface-600'}`}>
          Demo replay
          <span className="block text-[11px] font-normal text-amber-300/80">Fixture data · IBM Bob not invoked</span>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2 max-h-72 md:max-h-none">
        <p className="text-[11px] text-gray-500 uppercase tracking-widest px-2 py-1">Missions</p>
        {missions.error && <div className="px-2"><StateMessage kind="error" onRetry={() => { void loadMissions(); }}>Could not load missions: {missions.error}</StateMessage></div>}
        {!missions.loaded && missions.loading && <p className="text-xs text-gray-500 px-2 py-2">Loading missions…</p>}
        {missions.loaded && missions.data.length === 0 && <p className="text-xs text-gray-500 px-2 py-2">No missions yet.</p>}
        <ul>
          {missions.data.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => selectMission(m.id)} aria-current={view === 'live' && activeMissionId === m.id ? 'true' : undefined}
                className={`w-full text-left px-3 py-2 rounded mb-1 ${view === 'live' && activeMissionId === m.id ? 'bg-surface-600 border border-surface-500' : 'hover:bg-surface-700 border border-transparent'}`}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-xs text-gray-400 font-mono">{m.id.slice(0, 8)}</span>
                  <StatusBadge status={m.status} />
                </div>
                <p className="text-xs text-gray-200 truncate">{m.issue_text}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{formatTime(m.created_at)}</p>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <div className="px-4 py-3 border-t border-surface-600 space-y-2 text-xs">
        <div className="flex items-center gap-2" data-testid="app-mode">
          <span className="text-gray-400">Mode:</span>
          {view === 'replay' ? <Badge tone="warning">demo replay</Badge> : <Badge tone="neutral">live mission</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          <span className="text-gray-300">Live updates: {wsConnected ? 'connected' : 'disconnected (retrying)'}</span>
        </div>
        <div className="flex items-center gap-2" data-testid="bob-health">
          <span className="text-gray-400">IBM Bob:</span>
          {view === 'replay' ? <Badge tone="warning">not invoked</Badge>
            : !bob.loaded ? <span className="text-gray-500">checking…</span>
              : bob.data?.available ? <Badge tone="success">available{bob.data.version ? ` ${bob.data.version}` : ''}</Badge>
                : bob.data ? <Badge tone="danger">unavailable</Badge>
                  : <Badge tone="muted">unknown</Badge>}
        </div>
        {view !== 'replay' && bob.data?.available && <p className="text-[11px] text-gray-500">Availability does not prove authentication or remaining credits.</p>}
      </div>
    </aside>
  );
}
