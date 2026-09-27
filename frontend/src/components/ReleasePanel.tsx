/**
 * ReleasePanel.tsx — The deterministic release decision (from the backend) and Bob's
 * narrative, rendered as two separate, clearly labelled sections. React never computes
 * or adjusts the verdict.
 */

import React from 'react';
import type { ReleaseVerdictResult } from '../types';
import type { BobNarrative } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, Panel, StateMessage, StatusBadge } from './ui';

const VERDICT_LABEL: Record<string, string> = { ready: 'READY', conditional: 'CONDITIONAL', blocked: 'BLOCKED' };

export function DeterministicDecision({ verdict, loading, error, loaded, onRetry }: {
  verdict: ReleaseVerdictResult | null;
  loading: boolean;
  error: string | null;
  loaded: boolean;
  onRetry: () => void;
}): React.ReactElement {
  const { replay } = useDisplay();
  const label = verdict?.verdict ? VERDICT_LABEL[verdict.verdict] ?? verdict.verdict.toUpperCase() : 'NO VERDICT';
  const tone = verdict?.verdict === 'ready' ? 'success' : verdict?.verdict === 'conditional' ? 'warning' : verdict?.verdict === 'blocked' ? 'danger' : 'muted';
  return (
    <Panel title="DETERMINISTIC RELEASE DECISION" subtitle={replay
      ? "Computed by ForgeGuard's release-verdict logic over the replay fixture's validation rows. Bob cannot change it."
      : 'Computed by the backend from stored validation evidence. Bob cannot change it.'}>
      {error && <StateMessage kind="error" onRetry={onRetry}>Failed to load the release verdict: {error}</StateMessage>}
      {!loaded && loading && <StateMessage kind="loading">Loading release verdict…</StateMessage>}
      {loaded && (
        <div data-testid="deterministic-verdict" data-verdict={verdict?.verdict ?? 'none'}>
          <div className="flex items-center gap-3">
            <span className={`text-xl font-bold tracking-wider ${tone === 'success' ? 'text-emerald-300' : tone === 'warning' ? 'text-amber-300' : tone === 'danger' ? 'text-red-300' : 'text-gray-400'}`}>
              {label}
            </span>
            {verdict?.implementationSucceeded === false && <Badge tone="danger">implementation did not succeed</Badge>}
          </div>
          {!verdict?.verdict && (
            <p className="mt-1 text-xs text-gray-400">No release verdict available. No evidence, no claim.</p>
          )}
          {verdict && verdict.reasons.length > 0 && (
            <ul className="mt-2 space-y-1 list-disc pl-5 text-sm text-gray-200" data-testid="verdict-reasons">
              {verdict.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          {verdict && verdict.commands.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-xs">
                <caption className="sr-only">Per-command evidence</caption>
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="py-1 pr-3 font-medium">Command</th>
                    <th className="py-1 pr-3 font-medium">Baseline</th>
                    <th className="py-1 pr-3 font-medium">Post</th>
                    <th className="py-1 font-medium">Classification</th>
                  </tr>
                </thead>
                <tbody>
                  {verdict.commands.map((c) => (
                    <tr key={c.command} className="border-t border-surface-600">
                      <td className="py-1 pr-3 font-mono text-gray-200">{c.command}</td>
                      <td className="py-1 pr-3"><StatusBadge status={c.baseline} /></td>
                      <td className="py-1 pr-3"><StatusBadge status={c.post} /></td>
                      <td className="py-1 font-mono text-gray-300">{c.classification.replace(/_/g, ' ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

export function BobAnalysis({ narrative, verdict, transparencyNote = null }: {
  narrative: BobNarrative | null;
  verdict: string | null;
  transparencyNote?: string | null;
}): React.ReactElement {
  const { replay } = useDisplay();
  return (
    <Panel title="AI / BOB ANALYSIS" subtitle={replay
      ? 'REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE. Not produced by IBM Bob; not authoritative.'
      : "Narrative from Bob's release report. Supporting analysis only; not authoritative."}>
      {transparencyNote && (
        <p className="mb-3 text-xs text-amber-200 border-l-2 border-amber-600 pl-2" data-testid="transparency-note">{transparencyNote}</p>
      )}
      {!narrative ? (
        <StateMessage kind="empty">No Bob release narrative. Phase 6 has not produced a report for this mission.</StateMessage>
      ) : (
        <div data-testid="bob-analysis">
          {narrative.discrepancy && (
            <div role="note" className="mb-3 rounded border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-200" data-testid="verdict-discrepancy">
              <strong className="block text-amber-100 tracking-wide">DISAGREEMENT DETECTED</strong>
              {narrative.discrepancy}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
            {replay ? 'Synthetic Bob narrative recommends:' : 'Bob recommends:'}
            {narrative.bobAssessment ? <Badge tone="muted">{narrative.bobAssessment}</Badge> : <span>no assessment given</span>}
            {verdict && <span className="text-gray-500">(deterministic decision: {verdict})</span>}
          </div>
          {narrative.summary && <p className="mt-2 text-sm text-gray-200 whitespace-pre-wrap">{narrative.summary}</p>}
          {narrative.recommendation && <p className="mt-2 text-xs text-gray-400">Recommendation: <span className="text-gray-200">{narrative.recommendation}</span></p>}
          {narrative.remainingRisks.length > 0 && (
            <div className="mt-2">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">Remaining risks</p>
              <ul className="list-disc pl-5 text-sm text-gray-300">{narrative.remainingRisks.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
