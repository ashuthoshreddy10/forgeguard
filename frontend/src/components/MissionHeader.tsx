/**
 * MissionHeader.tsx — Identity and backend status of the selected mission.
 */

import React from 'react';
import type { Mission, PipelinePhase } from '../types';
import { currentPhase, missionCategory, phaseLabel, redactPaths, repoName } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, CollapsibleOutput, Field, toneOf } from './ui';

const CATEGORY_LABEL: Record<string, string> = {
  pending: 'Pending', running: 'Running', awaiting_approval: 'Awaiting approval',
  complete: 'Complete', failed: 'Failed', rolled_back: 'Rolled back',
};

export function MissionHeader({ mission, latest, actions }: {
  mission: Mission;
  latest: Partial<Record<string, PipelinePhase>>;
  actions?: React.ReactNode;
}): React.ReactElement {
  const { formatTime, replay } = useDisplay();
  const category = missionCategory(mission.status);
  const phase = currentPhase(latest);
  const tone = category === 'pending' ? 'neutral' : toneOf(category === 'running' ? 'running' : category);

  return (
    <header className="bg-surface-800 border-b border-surface-600 px-6 py-4" aria-label="Mission header">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold text-gray-100">Mission</h1>
            <code className="text-xs text-sky-300 font-mono break-all" title="Mission ID">{mission.id}</code>
            <span data-testid="mission-status">
              <Badge tone={tone} title={`Backend status: ${mission.status}`}>
                {replay && category === 'running' ? 'In progress' : CATEGORY_LABEL[category]}{category === 'running' || category === 'pending' ? ` · ${mission.status.replace(/_/g, ' ')}` : ''}
              </Badge>
            </span>
            {replay && <Badge tone="warning" title="Deterministic fixture data; IBM Bob is not invoked">Replay fixture</Badge>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <dl className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-2">
        <Field label="Repository"><span title={mission.repo_path} className="font-mono">{repoName(mission.repo_path)}</span>{replay && <span className="text-xs text-gray-400"> (fixture; not modified)</span>}</Field>
        <Field label="Current phase">
          {phase ? `${phaseLabel(phase.phase_name)} (${phase.status})` : 'Not started'}
        </Field>
        <Field label="Created">{formatTime(mission.created_at)}</Field>
        <Field label="Updated">{formatTime(mission.updated_at)}</Field>
      </dl>

      <div className="mt-3">
        <CollapsibleOutput label="Issue / change request" text={mission.issue_text} collapsedLines={4} />
      </div>

      {mission.status === 'failed' && mission.error_message && (
        <p role="alert" className="mt-3 text-sm text-red-300 border-l-2 border-red-600 pl-3" data-testid="mission-error">
          {redactPaths(mission.error_message)}
        </p>
      )}
    </header>
  );
}
