/**
 * ValidationPanel.tsx — Real validation_runs rows of the current mission run,
 * baseline and post-implementation shown separately, with full stdout/stderr.
 */

import React from 'react';
import type { ValidationRun } from '../types';
import { formatDuration, runState } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, CollapsibleOutput, Panel, StateMessage, StatusBadge } from './ui';

function RunCard({ run }: { run: ValidationRun }): React.ReactElement {
  const { formatTime } = useDisplay();
  const state = runState(run);
  return (
    <li className="rounded border border-surface-600 bg-surface-900/40 p-3" data-testid="validation-run" data-kind={run.run_kind} data-state={state}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-sm text-gray-100 font-mono">{run.command}</code>
        <Badge tone={run.run_kind === 'baseline' ? 'neutral' : 'info'}>{run.run_kind === 'baseline' ? 'baseline' : 'post'}</Badge>
        <StatusBadge status={state} />
      </div>
      <dl className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
        <div><dt className="text-gray-500 inline">Exit code: </dt>
          <dd className="inline font-mono text-gray-200">{state === 'timed_out' ? 'none (killed on timeout)' : run.exit_code ?? '—'}</dd></div>
        <div><dt className="text-gray-500 inline">Duration: </dt><dd className="inline font-mono text-gray-200">{formatDuration(run.duration_ms)}</dd></div>
        <div><dt className="text-gray-500 inline">Started: </dt><dd className="inline text-gray-200">{formatTime(run.started_at)}</dd></div>
        <div><dt className="text-gray-500 inline">Ended: </dt><dd className="inline text-gray-200">{formatTime(run.completed_at)}</dd></div>
      </dl>
      <div className="mt-2 space-y-2">
        <CollapsibleOutput label="stdout" text={run.stdout} collapsedLines={6} />
        <CollapsibleOutput label="stderr" text={run.stderr} collapsedLines={6} tone="error" />
      </div>
    </li>
  );
}

function Section({ title, subtitle, runs, empty }: { title: string; subtitle: string; runs: ValidationRun[]; empty: string }): React.ReactElement {
  return (
    <div data-testid={`validation-${title.startsWith('BASELINE') ? 'baseline' : 'post'}`}>
      <h3 className="text-xs font-semibold tracking-widest text-gray-300">{title}</h3>
      <p className="text-xs text-gray-500 mb-2">{subtitle}</p>
      {runs.length === 0
        ? <StateMessage kind="empty">{empty}</StateMessage>
        : <ul className="space-y-2">{runs.map((r) => <RunCard key={r.id} run={r} />)}</ul>}
    </div>
  );
}

export function ValidationPanel({ baseline, post, earlierRuns, loading, error, loaded, onRetry }: {
  baseline: ValidationRun[];
  post: ValidationRun[];
  earlierRuns: number;
  loading: boolean;
  error: string | null;
  loaded: boolean;
  onRetry: () => void;
}): React.ReactElement {
  const { replay } = useDisplay();
  return (
    <Panel title="Validation results" subtitle={replay
      ? 'Replay fixture results. No command was executed and the repository was not touched.'
      : 'Real command executions stored by the backend (validation_runs).'}>
      {error && <StateMessage kind="error" onRetry={onRetry}>Failed to load validation runs: {error}</StateMessage>}
      {!loaded && loading && <StateMessage kind="loading">Loading validation runs…</StateMessage>}
      {loaded && baseline.length === 0 && post.length === 0 && (
        <StateMessage kind="empty">No validation results yet.</StateMessage>
      )}
      {loaded && (baseline.length > 0 || post.length > 0) && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <Section title="BASELINE" subtitle="Before analysis and implementation." runs={baseline} empty="No baseline runs for this mission run." />
          <Section title="POST-IMPLEMENTATION" subtitle="After implementation." runs={post} empty="Post-implementation validation has not run." />
        </div>
      )}
      {earlierRuns > 0 && (
        <p className="mt-3 text-xs text-gray-500">{earlierRuns} run{earlierRuns === 1 ? '' : 's'} from earlier attempts of this mission are not shown.</p>
      )}
    </Panel>
  );
}
