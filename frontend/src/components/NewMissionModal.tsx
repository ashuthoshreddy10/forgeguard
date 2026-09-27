/**
 * NewMissionModal.tsx — Create a mission. Backend validation errors are shown verbatim
 * (code + message); the character limit mirrors the backend's documented limit.
 */

import React, { useEffect, useState } from 'react';
import type { ApiResult } from '../api';
import type { Mission } from '../types';
import { Button } from './ui';

/** Mirrors MAX_ISSUE_TEXT_LENGTH in backend/src/config.ts; the backend enforces it. */
export const MAX_ISSUE_TEXT_LENGTH = 12_000;

const QUICK_LOAD_SCENARIOS = [
  {
    label: 'Bug fix: discount clamping',
    issueText:
      'The calculateDiscount() function in the pricing module returns incorrect results when the discount rate exceeds 100%. It should clamp the rate to the range [0, 100] to prevent negative prices. This bug affects the applyOrderDiscount() function and the /api/orders/discount endpoint.',
  },
  {
    label: 'Feature: formatCurrency()',
    issueText:
      'The formatCurrency() function in utils.ts is currently a stub that returns an empty string. Implement it so it returns a properly locale-formatted USD currency string (e.g. $1,234.56). Update the /api/orders/discount endpoint response and add tests.',
  },
];

export function NewMissionModal({ onClose, onSubmit }: {
  onClose: () => void;
  onSubmit: (issueText: string) => Promise<ApiResult<Mission>>;
}): React.ReactElement {
  const [issueText, setIssueText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tooLong = issueText.length > MAX_ISSUE_TEXT_LENGTH;
  const submit = async (): Promise<void> => {
    if (!issueText.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const r = await onSubmit(issueText);
    setSubmitting(false);
    if (r.ok) onClose();
    else setError(`${r.error.code ? `${r.error.code}: ` : ''}${r.error.error ?? 'Mission could not be created'}`);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} aria-hidden />
      <div className="fixed inset-0 flex items-center justify-center z-50 px-4">
        <div role="dialog" aria-modal="true" aria-labelledby="new-mission-title" className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-2xl">
          <div className="px-5 py-4 border-b border-surface-600 flex items-center justify-between">
            <div>
              <h2 id="new-mission-title" className="text-sm font-semibold text-gray-100">New mission</h2>
              <p className="text-xs text-gray-400">Describe the issue or change request</p>
            </div>
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm" aria-label="Close">Close ✕</button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <p className="text-xs text-gray-400 mb-2">Load a demo-app scenario:</p>
              <div className="flex gap-2 flex-wrap">
                {QUICK_LOAD_SCENARIOS.map((s) => (
                  <Button key={s.label} onClick={() => setIssueText(s.issueText)}>{s.label}</Button>
                ))}
              </div>
            </div>
            <div>
              <label htmlFor="issue-text" className="text-xs text-gray-300 block mb-1.5">Issue / change request</label>
              <textarea id="issue-text" value={issueText} onChange={(e) => setIssueText(e.target.value)} rows={7}
                className="w-full bg-surface-900 border border-surface-500 rounded text-sm text-gray-100 px-3 py-2 font-mono resize-y focus:outline-none focus:border-sky-500" />
              <p className={`text-xs mt-1 ${tooLong ? 'text-red-300' : 'text-gray-500'}`}>
                {issueText.length.toLocaleString()} / {MAX_ISSUE_TEXT_LENGTH.toLocaleString()} characters
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-300 mb-1.5">Repository</p>
              <p className="px-3 py-2 bg-surface-900 border border-surface-600 rounded text-xs text-gray-400 font-mono">
                demo-app (default; the backend only accepts allow-listed repositories)
              </p>
            </div>
            {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          </div>
          <div className="px-5 pb-5 flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => { void submit(); }} disabled={!issueText.trim() || submitting}>
              {submitting ? 'Creating…' : 'Create mission'}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
