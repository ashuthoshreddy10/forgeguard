/**
 * FailurePanel.tsx — Why the mission/phase failed, from the backend's sanitized error data.
 */

import React from 'react';
import type { FailureDetails } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, Field, Panel } from './ui';

export function FailurePanel({ failure, onOpenEvidence }: { failure: FailureDetails; onOpenEvidence: () => void }): React.ReactElement {
  const { formatTime } = useDisplay();
  const { classification } = failure;
  return (
    <div role="alert" data-testid="failure-panel">
      <Panel
        tone="danger"
        title={failure.phaseLabel ? `Failed in phase: ${failure.phaseLabel}` : 'Mission failed'}
        subtitle="The pipeline stopped. Later phases were not executed."
        actions={<button type="button" onClick={onOpenEvidence} className="text-xs text-red-200 underline hover:text-white">View error evidence</button>}
      >
        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
          <Field label="Classification">
            <span className="flex flex-wrap gap-1">
              <Badge tone="danger">{classification.code}</Badge>
              {classification.kind && <Badge tone="muted">{classification.kind}</Badge>}
            </span>
          </Field>
          <Field label="Agent / task">{failure.taskType ?? '—'}{failure.taskStatus ? ` (${failure.taskStatus})` : ''}</Field>
          <Field label="Task ID"><code className="text-xs font-mono break-all">{failure.taskId ?? '—'}</code></Field>
          <Field label="Time">{formatTime(failure.timestamp)}</Field>
        </dl>
        <p className="mt-3 text-sm text-red-200 whitespace-pre-wrap break-words" data-testid="failure-reason">{classification.reason}</p>
      </Panel>
    </div>
  );
}
