/**
 * EvidenceDrawer.tsx — The mission's evidence rows, grouped by type, with agent details.
 * Evidence is loaded with the mission (not when the drawer opens), so counts are correct
 * immediately. Content is shown as stored by the backend (already secret-redacted).
 */

import React, { useEffect, useMemo, useState } from 'react';
import type { AgentTask, EvidenceItem } from '../types';
import { EVIDENCE_GROUPS, agentInfoByTask, groupEvidence, type AgentInfo } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, CollapsibleOutput, StateMessage, StatusBadge } from './ui';

function EvidenceCard({ item, agent }: { item: EvidenceItem; agent: AgentInfo | undefined }): React.ReactElement {
  const { formatTime, replay } = useDisplay();
  return (
    <li className="rounded border border-surface-600 bg-surface-900/40 p-3" data-testid="evidence-item">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono uppercase text-gray-300">{item.evidence_type.replace(/_/g, ' ')}</span>
        <span className="text-gray-500">phase: {item.phase_name}</span>
        {replay && <Badge tone="warning">Replay fixture</Badge>}
        <span className="text-gray-500 ml-auto">{formatTime(item.created_at)}</span>
      </div>
      {item.task_id && (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-gray-400">
          <div><dt className="inline">Agent: </dt><dd className="inline text-gray-200">{agent?.taskType ?? 'unknown'}</dd></div>
          <div><dt className="inline">Status: </dt><dd className="inline">{agent ? <StatusBadge status={agent.status} /> : '—'}</dd></div>
          <div className="col-span-2"><dt className="inline">ForgeGuard task: </dt><dd className="inline font-mono break-all">{item.task_id}</dd></div>
          <div className="col-span-2"><dt className="inline">Bob task: </dt><dd className="inline font-mono break-all">{agent?.bobTaskId ?? (replay ? 'none (replay fixture; IBM Bob not invoked)' : 'not reported')}</dd></div>
          <div><dt className="inline">Started: </dt><dd className="inline">{formatTime(agent?.startedAt)}</dd></div>
          <div><dt className="inline">Completed: </dt><dd className="inline">{formatTime(agent?.completedAt)}</dd></div>
        </dl>
      )}
      <div className="mt-2">
        <CollapsibleOutput label="content" text={item.content} collapsedLines={10} tone={item.evidence_type === 'error' ? 'error' : 'default'} />
      </div>
    </li>
  );
}

export function EvidenceDrawer({ open, onClose, evidence, tasks, loading, error, onRetry }: {
  open: boolean;
  onClose: () => void;
  evidence: EvidenceItem[];
  tasks: AgentTask[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}): React.ReactElement | null {
  const { replay } = useDisplay();
  const groups = useMemo(() => groupEvidence(evidence), [evidence]);
  const agents = useMemo(() => agentInfoByTask(tasks, evidence), [tasks, evidence]);
  const firstNonEmpty = EVIDENCE_GROUPS.find((g) => (groups[g.key]?.length ?? 0) > 0)?.key ?? 'prompt';
  const [tab, setTab] = useState<string>(firstNonEmpty);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => { if (open) setTab(firstNonEmpty); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;
  const items = groups[tab] ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} aria-hidden />
      <div role="dialog" aria-modal="true" aria-label="Evidence"
        className="fixed right-0 top-0 h-full w-full max-w-2xl bg-surface-800 border-l border-surface-600 z-50 flex flex-col">
        <div className="px-4 py-3 border-b border-surface-600 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-gray-100">{replay ? 'Evidence (replay fixtures)' : 'Evidence'}</h2>
            <p className="text-xs text-gray-400">{evidence.length} item{evidence.length === 1 ? '' : 's'} {replay ? 'from the replay fixture, not produced by IBM Bob' : 'recorded by the backend'}</p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm" aria-label="Close evidence">Close ✕</button>
        </div>
        <div role="tablist" aria-label="Evidence types" className="px-4 pt-3 flex flex-wrap gap-1 border-b border-surface-600">
          {EVIDENCE_GROUPS.filter((g) => g.key !== 'other' || (groups['other']?.length ?? 0) > 0).map((g) => (
            <button key={g.key} type="button" role="tab" aria-selected={tab === g.key} onClick={() => setTab(g.key)}
              className={`px-3 py-1.5 text-xs rounded-t border-b-2 ${tab === g.key ? 'border-sky-400 text-white' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
              {g.label} ({groups[g.key]?.length ?? 0})
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && <StateMessage kind="error" onRetry={onRetry}>Failed to load evidence: {error}</StateMessage>}
          {loading && evidence.length === 0 && <StateMessage kind="loading">Loading evidence…</StateMessage>}
          {!loading && evidence.length === 0 && !error && <StateMessage kind="empty">No evidence recorded.</StateMessage>}
          {evidence.length > 0 && items.length === 0 && <StateMessage kind="empty">No evidence of this type.</StateMessage>}
          <ul className="space-y-2">
            {items.map((e) => <EvidenceCard key={e.id} item={e} agent={e.task_id ? agents[e.task_id] : undefined} />)}
          </ul>
        </div>
      </div>
    </>
  );
}
