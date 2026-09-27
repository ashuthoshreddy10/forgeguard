/**
 * AgentPanels.tsx — Agent tasks of the current run and live Bob output.
 * Live output only ever comes from real `agent.output` WebSocket events; there are no
 * timers or placeholders that suggest an agent is working.
 */

import React from 'react';
import type { AgentTask, PipelinePhase } from '../types';
import type { LiveOutput } from '../store/store';
import { formatDuration, redactPaths } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Panel, StateMessage, StatusBadge } from './ui';

const SPECIALISTS = [
  { type: 'code_impact_analyst', label: 'Code Impact' },
  { type: 'test_engineer', label: 'Test Engineer' },
  { type: 'security_analyst', label: 'Security' },
  { type: 'api_compat_analyst', label: 'API Compatibility' },
  { type: 'doc_analyst', label: 'Documentation' },
];

export function ParallelAnalysisGrid({ phase, tasks }: { phase: PipelinePhase | undefined; tasks: AgentTask[] }): React.ReactElement {
  const { replay } = useDisplay();
  const phaseTasks = phase ? tasks.filter((t) => t.phase_id === phase.id) : [];
  return (
    <Panel title="Parallel specialist analysis" subtitle={replay
      ? 'Replay fixture: 5 specialist results. No Bob session ran.'
      : '5 parallel Bob sessions (independent bob processes), current run only.'}
      actions={<StatusBadge status={phase?.status ?? 'pending'} />}>
      {!phase || phase.status === 'skipped' ? (
        <StateMessage kind="empty">{phase?.status === 'skipped' ? 'Skipped: an earlier phase failed.' : 'Not started.'}</StateMessage>
      ) : (
        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {SPECIALISTS.map((s) => {
            const t = phaseTasks.find((x) => x.task_type === s.type);
            return (
              <li key={s.type} className="rounded border border-surface-600 bg-surface-900/40 p-2">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-xs font-medium text-gray-200">{s.label}</span>
                  <StatusBadge status={t?.status ?? 'pending'} />
                </div>
                <p className="mt-1 text-[11px] text-gray-500 font-mono">{t ? formatDuration(t.duration_ms) : 'no task'}</p>
                {t?.error_message && <p className="mt-1 text-[11px] text-red-300 line-clamp-3">{redactPaths(t.error_message)}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function AgentOutputPanel({ tasks, liveOutput }: { tasks: AgentTask[]; liveOutput: LiveOutput[] }): React.ReactElement {
  const { replay } = useDisplay();
  const running = tasks.filter((t) => t.status === 'running');
  if (replay) {
    return (
      <Panel title="Bob agent output" subtitle="Replay mode: IBM Bob is not invoked.">
        <StateMessage kind="empty">
          Replay fixtures contain no streamed Bob output. The fixture results for each task are in the evidence drawer, marked as replay fixtures.
        </StateMessage>
      </Panel>
    );
  }
  return (
    <Panel title="Bob agent output" subtitle="Streamed assistant text from running Bob tasks (WebSocket agent.output)."
      actions={running.length > 0 ? <StatusBadge status="running" /> : undefined}>
      {liveOutput.filter((o) => o.text).length === 0 ? (
        <StateMessage kind="empty">
          No live Bob output available.{running.length > 0 ? ` ${running.length} task(s) are marked running by the backend.` : ''}
        </StateMessage>
      ) : (
        <div className="space-y-2" data-testid="live-output">
          {liveOutput.filter((o) => o.text).map((o) => (
            <div key={o.taskId}>
              <p className="text-xs text-gray-400 font-mono">{o.taskType} · {o.taskId}</p>
              <pre className="mt-1 text-xs font-mono whitespace-pre-wrap text-gray-200 bg-surface-900 border border-surface-600 rounded p-2 max-h-64 overflow-auto">{o.text}</pre>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
