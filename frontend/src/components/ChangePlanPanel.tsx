/**
 * ChangePlanPanel.tsx — The change plan synthesized in Phase 3 and the approval gate.
 * Approval is offered only while the backend reports `awaiting_approval` and the
 * change_plan phase completed (the backend fails that phase for an invalid plan).
 */

import React, { useState } from 'react';
import type { Mission, PipelinePhase } from '../types';
import { parseChangePlan } from '../lib/selectors';
import { Badge, Button, Field, Panel, StateMessage } from './ui';

const RISK_TONE: Record<string, 'success' | 'warning' | 'danger'> = { low: 'success', medium: 'warning', high: 'danger', critical: 'danger' };

function List({ items, mono = false }: { items: string[]; mono?: boolean }): React.ReactElement {
  return <ul className={`list-disc pl-5 text-sm text-gray-200 ${mono ? 'font-mono text-xs' : ''}`}>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

export function ChangePlanPanel({ mission, planPhase, busy, onApprove }: {
  mission: Mission;
  planPhase: PipelinePhase | undefined;
  busy: boolean;
  onApprove: () => Promise<{ ok: boolean; error?: string }>;
}): React.ReactElement | null {
  const [approveError, setApproveError] = useState<string | null>(null);
  const plan = parseChangePlan(mission.change_plan);
  const awaiting = mission.status === 'awaiting_approval';
  if (!mission.change_plan && !awaiting) return null;

  const planValid = planPhase?.status === 'completed' && !!plan;
  const canApprove = awaiting && planValid && mission.plan_approved !== 1;
  const approvalState = mission.plan_approved === 1
    ? 'Approved'
    : awaiting ? (planValid ? 'Waiting for approval' : 'Plan not valid for approval') : 'Not approved';

  const approve = async (): Promise<void> => {
    setApproveError(null);
    const r = await onApprove();
    if (!r.ok) setApproveError(r.error ?? 'Approval failed');
  };

  return (
    <Panel
      tone={awaiting ? 'warning' : 'default'}
      title="Change plan"
      subtitle={`Approval: ${approvalState}`}
      actions={awaiting ? (
        <Button variant="success" onClick={() => { void approve(); }} disabled={!canApprove || busy}
          title={canApprove ? 'Approve the plan and start implementation' : 'The backend has not produced an approvable plan'}>
          {busy ? 'Approving…' : 'Approve & implement'}
        </Button>
      ) : undefined}
    >
      {approveError && <StateMessage kind="error">Approval refused: {approveError}</StateMessage>}
      {!plan ? (
        <StateMessage kind="empty">{mission.change_plan ? 'The stored plan could not be parsed; approval is disabled.' : 'Waiting for the change plan.'}</StateMessage>
      ) : (
        <div className="space-y-3" data-testid="change-plan">
          {plan.summary && <p className="text-sm text-gray-200">{plan.summary}</p>}
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Risk level">{plan.riskLevel ? <Badge tone={RISK_TONE[plan.riskLevel] ?? 'warning'}>{plan.riskLevel}</Badge> : '—'}</Field>
            {plan.rollbackPlan && <Field label="Rollback plan">{plan.rollbackPlan}</Field>}
          </dl>
          {plan.affectedFiles && plan.affectedFiles.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Affected files</p><List items={plan.affectedFiles} mono /></div>
          )}
          {plan.securityNotes && plan.securityNotes.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Risks / security notes</p><List items={plan.securityNotes} /></div>
          )}
          {plan.testingRequired && plan.testingRequired.length > 0 && (
            <div><p className="text-[11px] uppercase tracking-wider text-gray-500">Testing required</p><List items={plan.testingRequired} /></div>
          )}
          {plan.steps && plan.steps.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Steps</p>
              <ol className="mt-1 space-y-1">
                {plan.steps.map((s, i) => (
                  <li key={i} className="text-sm text-gray-200 flex gap-2">
                    <span className="text-gray-500 font-mono">{s.order ?? i + 1}.</span>
                    <span>{s.file && <code className="text-xs text-sky-300 mr-1">{s.file}</code>}{s.description}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
