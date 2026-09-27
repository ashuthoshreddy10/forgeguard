/**
 * ExecutionTimeline.tsx — Chronological history of every phase row and agent task,
 * including rows from earlier attempts (the stepper shows only the newest per phase).
 */

import React from 'react';
import type { AgentTask, PipelinePhase } from '../types';
import { formatDuration, phaseLabel } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Panel, StateMessage, StatusBadge } from './ui';

interface Entry { kind: 'phase' | 'task'; id: string; name: string; status: string; at: string | null; seq: number; durationMs: number | null }

export function ExecutionTimeline({ phases, tasks }: { phases: PipelinePhase[]; tasks: AgentTask[] }): React.ReactElement {
  const { formatTime } = useDisplay();
  const entries: Entry[] = [
    ...phases.map((p, i): Entry => ({
      kind: 'phase', id: p.id, name: phaseLabel(p.phase_name), status: p.status,
      at: p.started_at ?? p.completed_at ?? null, seq: p.seq ?? i, durationMs: null,
    })),
    ...tasks.map((t, i): Entry => ({
      kind: 'task', id: t.id, name: t.task_type.replace(/_/g, ' '), status: t.status,
      at: t.started_at ?? null, seq: t.seq ?? i, durationMs: t.duration_ms ?? null,
    })),
  ].sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '') || a.seq - b.seq);

  return (
    <Panel title="Execution timeline" subtitle={`${entries.length} recorded phase and task rows, oldest first`}>
      {entries.length === 0 ? (
        <StateMessage kind="empty">No phases or agent tasks recorded yet.</StateMessage>
      ) : (
        <ol className="max-h-80 overflow-y-auto divide-y divide-surface-700">
          {entries.map((e) => (
            <li key={`${e.kind}-${e.id}`} className="py-1.5 flex flex-wrap items-center gap-2 text-sm">
              <span className={`text-[11px] font-mono px-1 rounded ${e.kind === 'phase' ? 'text-amber-300 bg-amber-950/40' : 'text-sky-300 bg-sky-950/40'}`}>{e.kind}</span>
              <span className="text-gray-200 capitalize">{e.name}</span>
              <StatusBadge status={e.status} />
              <span className="ml-auto text-[11px] text-gray-500 font-mono">
                {formatTime(e.at)}{e.durationMs !== null ? ` · ${formatDuration(e.durationMs)}` : ''}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
