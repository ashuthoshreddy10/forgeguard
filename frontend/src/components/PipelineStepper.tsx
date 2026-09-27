/**
 * PipelineStepper.tsx — The six phases, each showing its NEWEST backend row.
 */

import React from 'react';
import type { PipelinePhase } from '../types';
import { PIPELINE_PHASES, blockedBy, formatDuration, phaseLabel, redactPaths } from '../lib/selectors';
import { StatusBadge } from './ui';

const MARK: Record<string, string> = { completed: '✓', failed: '✕', skipped: '–', running: '●', pending: '' };
const RING: Record<string, string> = {
  completed: 'border-emerald-600 text-emerald-300 bg-emerald-950',
  failed: 'border-red-600 text-red-300 bg-red-950',
  skipped: 'border-gray-600 text-gray-500 bg-gray-900 border-dashed',
  running: 'border-sky-500 text-sky-300 bg-sky-950',
  pending: 'border-gray-700 text-gray-500 bg-surface-700',
};

function duration(p: PipelinePhase): string | null {
  if (!p.started_at || !p.completed_at) return null;
  return formatDuration(new Date(p.completed_at).getTime() - new Date(p.started_at).getTime());
}

export function PipelineStepper({ latest }: { latest: Partial<Record<string, PipelinePhase>> }): React.ReactElement {
  return (
    <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3" aria-label="Pipeline phases">
      {PIPELINE_PHASES.map((def, i) => {
        const row = latest[def.key];
        const status = row?.status ?? 'pending';
        const prereq = blockedBy(row);
        const d = row ? duration(row) : null;
        return (
          <li key={def.key} data-testid={`phase-${def.key}`} data-status={status}
            className="rounded-lg border border-surface-600 bg-surface-800 p-3 flex flex-col gap-2 min-w-0">
            <div className="flex items-center gap-2">
              <span aria-hidden className={`w-7 h-7 flex-shrink-0 rounded-full border-2 flex items-center justify-center text-xs font-mono ${RING[status] ?? RING['pending']}`}>
                {MARK[status] || String(i + 1)}
              </span>
              <span className="text-sm text-gray-100 font-medium leading-tight">{def.label}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <StatusBadge status={status} />
              {d && <span className="text-[11px] text-gray-400 font-mono">{d}</span>}
            </div>
            {status === 'skipped' && (
              <p className="text-xs text-gray-400" data-testid={`blocked-by-${def.key}`}>
                Blocked by: <span className="text-gray-200">{prereq ? phaseLabel(prereq) : redactPaths(row?.error_message ?? 'an earlier failure')}</span>
              </p>
            )}
            {status === 'failed' && row?.error_message && (
              <p className="text-xs text-red-300 line-clamp-3" title={redactPaths(row.error_message)}>{redactPaths(row.error_message)}</p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
