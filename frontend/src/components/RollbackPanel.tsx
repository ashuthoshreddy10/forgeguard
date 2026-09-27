/**
 * RollbackPanel.tsx — Rollback control. Availability and every refusal reason come from
 * GET /rollback-status; the action calls POST /rollback. No rollback logic lives here.
 */

import React, { useState } from 'react';
import type { ReplayRollbackOutcome, RollbackOutcome, RollbackStatus } from '../types';
import { useDisplay } from '../lib/display';
import { Badge, Button, Panel, StateMessage } from './ui';

/** Display titles for the backend's rollback codes. */
const UNAVAILABLE_TITLE: Record<string, string> = {
  NO_ROLLBACK_ANCHOR: 'No rollback anchor',
  ROLLBACK_CONFLICT: 'Repository changed since the mission',
  REPO_LOCKED: 'Repository is locked by another operation',
  ROLLBACK_NOT_ALLOWED: 'Mission is not in a terminal state',
  ROLLBACK_ALREADY_DONE: 'Already rolled back',
  ROLLBACK_HEAD_MOVED: 'Commits were made after the anchor',
  ROLLBACK_NO_RESULT_SNAPSHOT: 'Post-mission snapshot missing',
  ANCHOR_MISMATCH: 'Anchor does not belong to this mission',
  ANCHOR_MISSING: 'Anchor no longer exists',
  ANCHOR_CORRUPT: 'Anchor is inconsistent',
  REPO_NOT_ALLOWED: 'Repository is not allowed',
  REPO_NOT_GIT: 'Repository is not a Git repository',
  ROLLBACK_STATUS_UNKNOWN: 'Rollback status unknown',
};

export function RollbackPanel({ status, loading, error, loaded, outcome, replayOutcome = null, busy, onRollback, onRetry }: {
  status: RollbackStatus | null;
  loading: boolean;
  error: string | null;
  loaded: boolean;
  outcome: RollbackOutcome | undefined;
  /** Replay only: the fixture's description of what a live rollback would restore. */
  replayOutcome?: ReplayRollbackOutcome | null;
  busy: boolean;
  onRollback: () => void;
  onRetry: () => void;
}): React.ReactElement {
  const [confirming, setConfirming] = useState(false);
  const { formatTime, replay } = useDisplay();

  return (
    <Panel
      title={replay ? 'Rollback · DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK' : 'Rollback'}
      subtitle={replay
        ? 'Shows the rollback workflow. In replay no Git ref exists and no file is changed.'
        : "Restores the exact pre-implementation state recorded in this mission's anchor."}>
      {error && <StateMessage kind="error" onRetry={onRetry}>Failed to load rollback status: {error}</StateMessage>}
      {!loaded && loading && <StateMessage kind="loading">Checking rollback availability…</StateMessage>}

      {replayOutcome && (
        <div role="status" data-testid="replay-rollback-outcome" className="mb-3 rounded border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-100">
          <strong className="block">DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK</strong>
          Replay state set to rolled back at {formatTime(replayOutcome.at)}. No file was restored or removed.
          {(replayOutcome.wouldRestore.length + replayOutcome.wouldRemove.length) > 0 && (
            <div className="mt-1">
              For comparison, the fixture says a real rollback of this change would:
              <ul className="font-mono mt-1">
                {replayOutcome.wouldRestore.map((p) => <li key={`wr-${p}`}>restore {p}</li>)}
                {replayOutcome.wouldRemove.map((p) => <li key={`wd-${p}`}>remove {p}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {outcome && (
        <div role={outcome.ok ? 'status' : 'alert'} data-testid="rollback-outcome"
          className={`mb-3 rounded border p-2 text-xs ${outcome.ok ? 'border-emerald-700 bg-emerald-950/40 text-emerald-200' : 'border-red-700 bg-red-950/40 text-red-200'}`}>
          {outcome.ok
            ? <>Rollback completed at {formatTime(outcome.at)}: {outcome.removed?.length ?? 0} file(s) removed, {outcome.restored?.length ?? 0} restored.</>
            : <>Rollback failed ({outcome.code ?? `HTTP ${outcome.httpStatus}`}): {outcome.error}</>}
          {outcome.ok && ((outcome.removed?.length ?? 0) + (outcome.restored?.length ?? 0)) > 0 && (
            <ul className="mt-1 font-mono">
              {outcome.removed?.map((p) => <li key={`r-${p}`}>removed {p}</li>)}
              {outcome.restored?.map((p) => <li key={`s-${p}`}>restored {p}</li>)}
            </ul>
          )}
        </div>
      )}

      {loaded && status && status.available && (
        <div data-testid="rollback-available">
          <p className="text-sm text-gray-200">
            {replay
              ? 'The fixture defines a rollback anchor for this mission. Rolling back here only changes the replay state.'
              : 'A valid anchor exists and the repository still matches the state this mission left.'}
          </p>
          {status.anchorRef && <p className="mt-1 text-xs text-gray-500 font-mono break-all">Anchor: {status.anchorRef}</p>}
          <div className="mt-3 flex gap-2">
            {!confirming
              ? <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy}>Roll back</Button>
              : (
                <>
                  <Button variant="danger" disabled={busy} onClick={() => { setConfirming(false); onRollback(); }}>
                    {busy ? 'Rolling back…' : 'Confirm rollback'}
                  </Button>
                  <Button onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
                </>
              )}
          </div>
        </div>
      )}

      {loaded && status && !status.available && (
        <div data-testid="rollback-unavailable">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-200">Rollback unavailable: {UNAVAILABLE_TITLE[status.code ?? ''] ?? 'Not possible right now'}</span>
            {status.code && <Badge tone="muted">{status.code}</Badge>}
          </div>
          {status.reason && <p className="mt-1 text-xs text-gray-400">{status.reason}</p>}
          {status.details?.changedPaths && status.details.changedPaths.length > 0 && (
            <div className="mt-2 text-xs text-gray-400">
              Changed since the mission ({status.details.changedCount ?? status.details.changedPaths.length}):
              <ul className="font-mono text-gray-300">{status.details.changedPaths.map((p) => <li key={p}>{p}</li>)}</ul>
            </div>
          )}
          {status.details?.lockedBy && <p className="mt-1 text-xs text-gray-400">Lock held by mission <code>{status.details.lockedBy}</code></p>}
        </div>
      )}
    </Panel>
  );
}
