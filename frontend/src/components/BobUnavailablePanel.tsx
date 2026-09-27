/**
 * BobUnavailablePanel.tsx — Dedicated state when the start preflight found Bob unavailable.
 * Shows only safe diagnostics (never paths, commands or keys).
 */

import React from 'react';
import type { BobUnavailableInfo } from '../lib/selectors';
import { useDisplay } from '../lib/display';
import { Badge, Field, Panel } from './ui';

export function BobUnavailablePanel({ info }: { info: BobUnavailableInfo }): React.ReactElement {
  const { formatTime } = useDisplay();
  const d = info.diagnostics;
  return (
    <div role="alert" data-testid="bob-unavailable">
      <Panel tone="danger" title="BOB UNAVAILABLE" subtitle="No pipeline phase was started and no Bob task ran.">
        <p className="text-sm text-gray-200">
          ForgeGuard could not start the engineering workflow because IBM Bob is currently unavailable.
        </p>
        <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-3">
          <Field label="Diagnostic status"><Badge tone="danger">{d.code ?? 'BOB_UNAVAILABLE'}</Badge></Field>
          <Field label="Provider">{d.provider ?? '—'}</Field>
          <Field label="Version">{d.version ?? 'not detected'}</Field>
          <Field label="Checked">{formatTime(info.at)}</Field>
        </dl>
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-wider text-gray-500">Reason</p>
          <p className="text-sm text-red-200 break-words" data-testid="bob-unavailable-reason">{d.error ?? 'Bob provider is not available'}</p>
        </div>
        {d.runSyntax && !d.runSyntax.supported && (
          <p className="mt-2 text-xs text-gray-300">Installed Bob CLI is missing required flags: {d.runSyntax.missingFlags.join(', ')}</p>
        )}
        <p className="mt-3 text-xs text-gray-500">
          Source: {info.source === 'start-response' ? 'response to the start request' : 'preflight evidence recorded for this mission'}.
        </p>
      </Panel>
    </div>
  );
}
