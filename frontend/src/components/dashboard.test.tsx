/**
 * Rendering tests: the dashboard shows backend state truthfully. Data comes from a
 * mocked backend (fixtures); nothing here represents a real Bob run.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './Dashboard';
import { RollbackPanel } from './RollbackPanel';
import { useStore, REFRESH_DEBOUNCE_MS } from '../store/store';
import { MID, evidence, mission, mockBackend, phase, run, type Backend } from '../test/fixtures';
import type { ForgeGuardEvent, ReleaseVerdictResult } from '../types';

const initial = useStore.getState();

async function show(b: Backend): Promise<ReturnType<typeof mockBackend>> {
  const fetchMock = mockBackend(b);
  useStore.setState({ wsConnected: true });
  await act(async () => {
    useStore.getState().selectMission(MID);
    await useStore.getState().refreshActive();
  });
  render(<Dashboard />);
  return fetchMock;
}

beforeEach(() => { useStore.setState(initial, true); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('mission failure', () => {
  it('1. a failed mission renders the error panel with phase, task, classification and reason', async () => {
    const p1 = phase('repo_understanding', 'failed', { error_message: 'repo_understander [bob_error] Bob reported an error: Budget exceeded' });
    const skipped = ['parallel_analysis', 'change_plan', 'implementation', 'validation', 'release_report']
      .map((n) => phase(n, 'skipped', { error_message: 'Blocked: phase "repo_understanding" failed' }));
    await show({
      mission: mission({ status: 'failed', error_message: 'Phase "repo_understanding" failed: repo_understander [bob_error] Bob reported an error: Budget exceeded' }),
      phases: [p1, ...skipped],
      tasks: [{ seq: 1, id: 'task-1', phase_id: p1.id, mission_id: MID, task_type: 'repo_understander', status: 'failed', bob_provider: 'shell', bob_mode: 'ask', workspace: 'demo-app', error_message: 'Budget exceeded' }],
    });

    const panel = screen.getByTestId('failure-panel');
    expect(within(panel).getByText('Failed in phase: Repo Understanding')).toBeTruthy();
    expect(within(panel).getByText('BOB_TASK_FAILED')).toBeTruthy();
    expect(within(panel).getByText('bob_error')).toBeTruthy();
    expect(within(panel).getByText('task-1')).toBeTruthy();
    expect(within(panel).getByTestId('failure-reason').textContent).toContain('Budget exceeded');
    expect(screen.getByTestId('mission-status').textContent).toContain('Failed');
  });

  it('2. skipped phases are displayed as skipped with the blocking prerequisite', async () => {
    await show({
      mission: mission({ status: 'failed', error_message: 'Phase "implementation" failed: x' }),
      phases: [
        phase('repo_understanding', 'completed'), phase('parallel_analysis', 'completed'), phase('change_plan', 'completed'),
        phase('implementation', 'failed', { error_message: 'x' }),
        phase('validation', 'skipped', { error_message: 'Blocked: phase "implementation" failed' }),
        phase('release_report', 'skipped', { error_message: 'Blocked: phase "implementation" failed' }),
      ],
    });
    expect(screen.getByTestId('phase-validation').dataset['status']).toBe('skipped');
    expect(screen.getByTestId('blocked-by-validation').textContent).toBe('Blocked by: Implementation');
    expect(screen.getByTestId('blocked-by-release_report').textContent).toBe('Blocked by: Implementation');
    expect(screen.getByTestId('phase-implementation').dataset['status']).toBe('failed');
  });

  it('3. after a re-run the stepper shows the newest phase row', async () => {
    await show({
      mission: mission({ status: 'analyzing' }),
      phases: [
        phase('repo_understanding', 'failed', { error_message: 'first attempt failed' }),
        phase('parallel_analysis', 'skipped', { error_message: 'Blocked: phase "repo_understanding" failed' }),
        phase('repo_understanding', 'completed'),
        phase('parallel_analysis', 'running'),
      ],
    });
    expect(screen.getByTestId('phase-repo_understanding').dataset['status']).toBe('completed');
    expect(screen.getByTestId('phase-parallel_analysis').dataset['status']).toBe('running');
    expect(screen.queryByTestId('failure-panel')).toBeNull();
  });
});

describe('Bob unavailable', () => {
  it('4. a 503 BOB_UNAVAILABLE start response shows the dedicated state, never a started mission', async () => {
    const b: Backend = {
      mission: mission({ status: 'created' }),
      start: { status: 503, body: {
        code: 'BOB_UNAVAILABLE', error: 'BOB_UNAVAILABLE: Bob Shell CLI not found on PATH.',
        diagnostics: { provider: 'shell', available: false, code: 'BOB_UNAVAILABLE', error: 'Bob Shell CLI not found on PATH.', command: 'C:\\Program Files\\nodejs\\node.exe', entryPoint: 'C:\\npm\\bob.js' },
      } },
    };
    await show(b);
    b.mission = mission({ status: 'failed', error_message: 'BOB_UNAVAILABLE: Bob Shell CLI not found on PATH.' });
    fireEvent.click(screen.getByRole('button', { name: 'Run pipeline' }));

    const panel = await screen.findByTestId('bob-unavailable');
    expect(within(panel).getByText('BOB UNAVAILABLE')).toBeTruthy();
    expect(panel.textContent).toContain('ForgeGuard could not start the engineering workflow because IBM Bob is currently unavailable.');
    expect(within(panel).getByText('shell')).toBeTruthy();
    expect(within(panel).getByTestId('bob-unavailable-reason').textContent).toBe('Bob Shell CLI not found on PATH.');
    expect(document.body.textContent).not.toContain('node.exe');
    expect(document.body.textContent).not.toContain('bob.js');
    expect(screen.queryByTestId('failure-panel')).toBeNull(); // shown as Bob unavailable, not a generic failure
    await waitFor(() => expect(screen.getByTestId('mission-status').textContent).toContain('Failed'));
  });
});

describe('validation and verdict', () => {
  const p1 = phase('repo_understanding', 'completed');
  const p4 = phase('implementation', 'completed');
  const p5 = phase('validation', 'failed', { error_message: 'Release blocked: ...' });
  const runs = [
    run('baseline', 'npm run typecheck', p1.id, 0),
    run('post', 'npm run typecheck', p5.id, 2, { stderr: 'error TS2322' }),
    run('post', 'npm test', p5.id, null, { timed_out: 1, passed: 0, stdout: 'partial output' }),
  ];

  it('5. baseline and post-implementation runs are shown in separate, labelled sections', async () => {
    await show({ mission: mission({ status: 'failed' }), phases: [p1, p4, p5], runs });
    const baseline = screen.getByTestId('validation-baseline');
    const post = screen.getByTestId('validation-post');
    expect(within(baseline).getByText('BASELINE')).toBeTruthy();
    expect(within(post).getByText('POST-IMPLEMENTATION')).toBeTruthy();
    expect(within(baseline).getAllByTestId('validation-run').map((e) => e.dataset['kind'])).toEqual(['baseline']);
    expect(within(post).getAllByTestId('validation-run').map((e) => e.dataset['state'])).toEqual(['failed', 'timed_out']);
    expect(post.textContent).toContain('none (killed on timeout)');
    expect(post.textContent).toContain('error TS2322');
  });

  it('6. the release verdict is the backend\'s, even where React might guess otherwise', async () => {
    // Every displayed run passed, but the backend says blocked: the UI must show BLOCKED.
    const verdict: ReleaseVerdictResult = {
      verdict: 'blocked', reasons: ['Implementation did not succeed, so there is no change that can be released'],
      commands: [], requiredCommands: ['npm test'], implementationSucceeded: false,
    };
    await show({ mission: mission({ status: 'failed' }), phases: [p1], runs: [run('baseline', 'npm test', p1.id, 0)], verdict });
    const v = screen.getByTestId('deterministic-verdict');
    expect(v.dataset['verdict']).toBe('blocked');
    expect(within(v).getByText('BLOCKED')).toBeTruthy();
    expect(within(v).getByTestId('verdict-reasons').textContent).toContain('Implementation did not succeed');
  });

  it('shows NO VERDICT when the backend has none', async () => {
    await show({ mission: mission({ status: 'created' }) });
    expect(within(screen.getByTestId('deterministic-verdict')).getByText('NO VERDICT')).toBeTruthy();
    expect(screen.getByText('No validation results yet.')).toBeTruthy();
    expect(screen.getByText(/No live Bob output available/)).toBeTruthy();
  });

  it('10. Bob\'s narrative and the deterministic verdict stay in separate sections, with the discrepancy shown', async () => {
    const verdict: ReleaseVerdictResult = {
      verdict: 'conditional', reasons: ['"npm run lint" failed before and after implementation: pre-existing failure, not a regression'],
      commands: [], requiredCommands: [], implementationSucceeded: true,
    };
    await show({
      mission: mission({
        status: 'complete',
        release_report: JSON.stringify({
          verdict: 'conditional', bobAssessment: 'ready', agreesWithVerdict: false,
          discrepancy: 'Bob\'s narrative assessed "ready" but the deterministic verdict from validation evidence is "conditional"; the deterministic verdict is used',
          bobNarrative: { releaseReadiness: 'ready', summary: 'All good from my side.' },
        }),
      }),
      verdict,
    });
    const decision = screen.getByRole('region', { name: 'DETERMINISTIC RELEASE DECISION' });
    const analysis = screen.getByRole('region', { name: 'AI / BOB ANALYSIS' });
    expect(within(decision).getByText('CONDITIONAL')).toBeTruthy();
    expect(decision.textContent).not.toContain('All good from my side');
    expect(decision.textContent).not.toMatch(/\bREADY\b/);
    expect(within(analysis).getByText('ready')).toBeTruthy();
    expect(within(analysis).getByText('All good from my side.')).toBeTruthy();
    expect(within(analysis).getByTestId('verdict-discrepancy').textContent).toContain('the deterministic verdict is used');
  });
});

describe('rollback control', () => {
  it('7. the rollback button is hidden when the backend says rollback is unavailable, with the reason', () => {
    render(<RollbackPanel loaded loading={false} error={null} outcome={undefined} busy={false} onRollback={() => undefined} onRetry={() => undefined}
      status={{ available: false, code: 'ROLLBACK_CONFLICT', reason: 'The repository changed after this mission finished', details: { changedPaths: ['src/dev.ts'], changedCount: 1 } }} />);
    expect(screen.queryByRole('button', { name: /roll back/i })).toBeNull();
    expect(screen.getByText('Rollback unavailable: Repository changed since the mission')).toBeTruthy();
    expect(screen.getByText('src/dev.ts')).toBeTruthy();
  });

  it('shows the button only when available and asks for confirmation before calling the API', () => {
    const onRollback = vi.fn();
    render(<RollbackPanel loaded loading={false} error={null} outcome={undefined} busy={false} onRollback={onRollback} onRetry={() => undefined}
      status={{ available: true, anchorRef: 'refs/forgeguard/anchors/m/abcd1234' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    expect(onRollback).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    expect(onRollback).toHaveBeenCalledTimes(1);
  });

  it('reports a failed rollback explicitly', () => {
    render(<RollbackPanel loaded loading={false} error={null} busy={false} onRollback={() => undefined} onRetry={() => undefined}
      status={{ available: false, code: 'ROLLBACK_ALREADY_DONE' }}
      outcome={{ ok: false, httpStatus: 409, code: 'ROLLBACK_CONFLICT', error: 'The repository changed', at: '2026-09-26T10:00:00.000Z' }} />);
    expect(screen.getByTestId('rollback-outcome').textContent).toContain('Rollback failed (ROLLBACK_CONFLICT)');
  });
});

describe('evidence and live state', () => {
  it('8. the evidence count is correct before the drawer is opened', async () => {
    await show({
      mission: mission({ status: 'failed', error_message: 'BOB_UNAVAILABLE: x' }),
      evidence: [evidence('error', 'preflight', '{"code":"BOB_UNAVAILABLE"}'), evidence('prompt', 'repo_understanding', 'p'), evidence('observation', 'baseline_validation', 'o')],
    });
    expect(useStore.getState().isEvidenceDrawerOpen).toBe(false);
    expect(screen.getByRole('button', { name: 'Evidence (3)' })).toBeTruthy();
  });

  it('9. duplicate WebSocket events and reconnects re-fetch from REST without duplicating phases', async () => {
    const phases = [phase('repo_understanding', 'failed', { error_message: 'boom' }), phase('parallel_analysis', 'skipped', { error_message: 'Blocked: phase "repo_understanding" failed' })];
    const fetchMock = await show({ mission: mission({ status: 'failed', error_message: 'Phase "repo_understanding" failed: boom' }), phases });
    vi.useFakeTimers();

    const ev = (type: ForgeGuardEvent['type']): ForgeGuardEvent => ({ type, timestamp: 't', missionId: MID, payload: { phaseName: 'repo_understanding' } });
    act(() => {
      for (let i = 0; i < 5; i++) useStore.getState().handleWsEvent(ev('phase.failed'));
      useStore.getState().handleWsEvent(ev('mission.failed'));
      useStore.getState().handleWsEvent(ev('mission.failed'));
    });
    const phaseFetches = (): number => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/phases')).length;
    const before = phaseFetches();
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DEBOUNCE_MS + 10); });
    expect(phaseFetches()).toBe(before + 1); // 7 events → one debounced re-fetch

    // Disconnect + reconnect twice: each reconnect rehydrates from REST.
    await act(async () => {
      useStore.getState().setWsConnected(false);
      useStore.getState().setWsConnected(true);
      useStore.getState().setWsConnected(false);
      useStore.getState().setWsConnected(true);
      await vi.runOnlyPendingTimersAsync();
    });
    vi.useRealTimers();
    await waitFor(() => expect(phaseFetches()).toBeGreaterThanOrEqual(before + 3));

    expect(useStore.getState().detail.phases.data).toHaveLength(2);
    expect(screen.getAllByTestId(/^phase-/)).toHaveLength(6);
    expect(screen.getByTestId('phase-repo_understanding').dataset['status']).toBe('failed');
    expect(useStore.getState().detail.mission.data?.status).toBe('failed'); // terminal state survives reconnect
  });

  it('ignores events for other missions and never invents live output', async () => {
    await show({ mission: mission({ status: 'created' }) });
    act(() => {
      useStore.getState().handleWsEvent({ type: 'agent.output', timestamp: 't', missionId: 'other', payload: { taskId: 'x', chunk: 'not ours' } });
    });
    expect(useStore.getState().liveOutput).toEqual([]);
    act(() => {
      useStore.getState().handleWsEvent({ type: 'agent.output', timestamp: 't', missionId: MID, payload: { taskId: 't1', taskType: 'repo_understander', chunk: 'Reading pricing.ts' } });
    });
    expect(await screen.findByTestId('live-output')).toBeTruthy();
    expect(screen.getByText('Reading pricing.ts')).toBeTruthy();
  });
});
