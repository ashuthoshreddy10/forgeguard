/**
 * Demo replay UI. Views come from src/test/replay-views.json, generated from the real
 * backend ReplayEngine (backend: npm run replay:snapshots; kept in sync by a backend test).
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshots from '../../test/replay-views.json';
import { ReplayWorkspace } from './ReplayWorkspace';
import { Dashboard } from '../Dashboard';
import { EvidenceDrawer } from '../EvidenceDrawer';
import { Sidebar } from '../Sidebar';
import { NewMissionModal } from '../NewMissionModal';
import { DisplayProvider, REPLAY_DISPLAY } from '../../lib/display';
import { useReplayStore, REPLAY_SESSION_KEY } from '../../store/replayStore';
import { useStore } from '../../store/store';
import type { ReplayView } from '../../types';
import { MID, mission, mockBackend } from '../../test/fixtures';

type ViewName = keyof typeof snapshots.views;
const V = (name: ViewName): ReplayView => JSON.parse(JSON.stringify(snapshots.views[name])) as ReplayView;

const initialReplay = useReplayStore.getState();
const initialMain = useStore.getState();

interface Call { url: string; method: string; body: unknown }
function mockReplayApi(responses: { current?: ReplayView; next?: ReplayView } = {}): { calls: Call[] } {
  const calls: Call[] = [];
  const json = (b: unknown, status = 200): Response => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/replay/scenarios') return json(snapshots.scenarios);
    if (/\/start$/.test(url)) return json(responses.next ?? responses.current ?? V('safe-fix@start'), 201);
    if (/\/control$/.test(url)) return json(responses.next ?? responses.current);
    if (method === 'DELETE') return json({ reset: true });
    if (url.startsWith('/api/replay/')) return responses.current ? json(responses.current) : json({ code: 'REPLAY_NOT_FOUND' }, 404);
    return json({ error: 'Not found' }, 404);
  }));
  return { calls };
}

function showSession(view: ReplayView): void {
  useReplayStore.setState({ session: view, scenarios: snapshots.scenarios, scenariosLoaded: true });
  render(<ReplayWorkspace />);
}

/** Visible text with the two mandated disclaimer phrases removed. */
const textWithoutDisclaimers = (): string => (document.body.textContent ?? '')
  .replace(/NOT A LIVE BOB RUN/g, '').replace(/NOT A LIVE REPOSITORY ROLLBACK/g, '');

beforeEach(() => {
  useReplayStore.setState(initialReplay, true);
  useStore.setState(initialMain, true);
  sessionStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('scenario selector', () => {
  it('1. lists the three scenarios with purpose and expected final state, and starts the chosen one', async () => {
    const { calls } = mockReplayApi({ next: V('safe-fix@start') });
    render(<ReplayWorkspace />);
    await screen.findByTestId('scenario-safe-fix');
    for (const [id, title, purpose, final] of [
      ['safe-fix', 'Safe Fix', 'Complete end-to-end successful engineering workflow', 'ready'],
      ['regression-blocked', 'Regression Blocked', 'Post-change validation exposes a regression', 'blocked'],
      ['bob-disagreement', 'Bob Disagreement', 'Model recommendation conflicts with deterministic evidence', 'conditional'],
    ] as const) {
      const card = screen.getByTestId(`scenario-${id}`);
      expect(card.textContent).toContain(title);
      expect(card.textContent).toContain(purpose);
      expect(card.textContent).toContain(`Final: ${final}`); // badge text; CSS renders it upper-case
    }
    expect(screen.getByText('FORGEGUARD DEMO REPLAY')).toBeTruthy();
    expect(screen.getByText('No live IBM Bob execution')).toBeTruthy();

    fireEvent.click(screen.getByTestId('scenario-regression-blocked'));
    fireEvent.click(screen.getByRole('button', { name: 'START REPLAY' }));
    await screen.findByTestId('replay-controls');
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/replay/regression-blocked/start')).toBe(true);
    expect(sessionStorage.getItem(REPLAY_SESSION_KEY)).toBe('replay-session-001');
  });
});

describe('replay banner', () => {
  it('2. is always visible in replay (selector and session) and never on a live mission', async () => {
    mockReplayApi();
    render(<ReplayWorkspace />);
    expect(screen.getByTestId('replay-banner').textContent).toContain('DEMO REPLAY — NOT A LIVE BOB RUN');
    expect(screen.getByTestId('replay-banner').textContent).toContain('IBM Bob not invoked');
    cleanup();

    showSession(V('safe-fix@end'));
    expect(screen.getByTestId('replay-banner')).toBeTruthy();
    cleanup();

    mockBackend({ mission: mission({ status: 'created' }) });
    await act(async () => { useStore.getState().selectMission(MID); await useStore.getState().refreshActive(); });
    useStore.setState({ wsConnected: true });
    render(<Dashboard />);
    expect(screen.queryByTestId('replay-banner')).toBeNull();
    expect(document.body.textContent).not.toMatch(/replay fixture/i);
  });
});

describe('playback', () => {
  it('3. phases progress with the backend replay state, and the approval gate is actionable', async () => {
    showSession(V('safe-fix@start'));
    expect(screen.getByTestId('phase-repo_understanding').dataset['status']).toBe('pending');
    cleanup();

    showSession(V('safe-fix@analysis'));
    expect(screen.getByTestId('phase-repo_understanding').dataset['status']).toBe('completed');
    expect(screen.getByTestId('phase-parallel_analysis').dataset['status']).toBe('running');
    cleanup();

    const { calls } = mockReplayApi({ next: V('safe-fix@end') });
    showSession(V('safe-fix@gate'));
    expect(screen.getByTestId('phase-change_plan').dataset['status']).toBe('completed');
    expect(screen.getByTestId('replay-status').textContent).toMatch(/waiting for approval/i);
    expect(screen.getByTestId('replay-time').textContent).toMatch(/^REPLAY TIME T\+5s \/ T\+12s/);
    fireEvent.click(within(screen.getByTestId('replay-approval')).getByRole('button', { name: 'Approve plan' }));
    await waitFor(() => expect(screen.getByTestId('phase-release_report').dataset['status']).toBe('completed'));
    expect(calls.find((c) => c.url.endsWith('/control'))?.body).toEqual({ action: 'approve' });
  });

  it('8. pause, play, skip, restart and speed call the replay control API', async () => {
    const { calls } = mockReplayApi({ next: V('safe-fix@analysis') });
    showSession(V('safe-fix@start'));
    const controls = (): number => calls.filter((c) => c.url.endsWith('/control')).length;
    // Controls are disabled while a request is in flight, so each click waits for the previous one.
    const clickAndWait = async (name: string, expected: number): Promise<void> => {
      await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(controls()).toBe(expected));
      await waitFor(() => expect(useReplayStore.getState().busy).toBe(false));
    };
    await clickAndWait('Pause', 1);
    await clickAndWait('Play', 2);
    await clickAndWait('Skip to next', 3);
    await clickAndWait('Restart', 4);
    await clickAndWait('4x', 5);
    expect(calls.filter((c) => c.url.endsWith('/control')).map((c) => c.body)).toEqual([
      { action: 'pause' }, { action: 'play' }, { action: 'next' }, { action: 'restart' }, { action: 'speed', speed: 4 },
    ]);
    expect(calls.every((c) => !c.url.startsWith('/api/missions'))).toBe(true); // never the live mission API
  });

  it('a replay.updated WebSocket event refreshes the replay, never live mission state', async () => {
    const { calls } = mockReplayApi({ current: V('safe-fix@analysis') });
    useReplayStore.setState({ session: V('safe-fix@start') });
    act(() => {
      useStore.getState().handleWsEvent({ type: 'replay.updated', timestamp: 't', missionId: 'replay-mission-safe-fix', payload: { replayId: 'replay-session-001', position: 4, status: 'paused' } });
    });
    await waitFor(() => expect(useReplayStore.getState().session?.position).toBe(4));
    expect(calls.map((c) => c.url)).toEqual(['/api/replay/replay-session-001']);
  });
});

describe('scenario rendering', () => {
  it('4. validation: baseline and post runs are shown separately and marked as not executed', () => {
    showSession(V('regression-blocked@end'));
    const baseline = screen.getByTestId('validation-baseline');
    const post = screen.getByTestId('validation-post');
    expect(within(baseline).getAllByTestId('validation-run').map((e) => e.dataset['state'])).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(within(post).getAllByTestId('validation-run').map((e) => `${e.querySelector('code')?.textContent}:${e.dataset['state']}`))
      .toEqual(['npm run lint:passed', 'npm test:failed', 'npm run typecheck:passed', 'npm run build:passed']);
    expect(post.textContent).toContain('REPLAY FIXTURE — command not executed');
    expect(screen.getByText(/No command was executed and the repository was not touched/)).toBeTruthy();
  });

  it('5. release verdict: READY for the safe fix, BLOCKED with the regression for the regression scenario', () => {
    showSession(V('safe-fix@end'));
    expect(screen.getByTestId('deterministic-verdict').dataset['verdict']).toBe('ready');
    cleanup();
    showSession(V('regression-blocked@end'));
    const v = screen.getByTestId('deterministic-verdict');
    expect(v.dataset['verdict']).toBe('blocked');
    expect(within(v).getByTestId('verdict-reasons').textContent).toContain('"npm test" exited 1 after implementation but passed in the baseline (regression)');
    expect(screen.getByTestId('failure-panel').textContent).toContain('RELEASE_BLOCKED');
  });

  it('6. Bob disagreement: CONDITIONAL decision and a synthetic READY narrative are separate, with DISAGREEMENT DETECTED', () => {
    showSession(V('bob-disagreement@end'));
    const decision = screen.getByRole('region', { name: 'DETERMINISTIC RELEASE DECISION' });
    const analysis = screen.getByRole('region', { name: 'AI / BOB ANALYSIS' });
    expect(screen.getByTestId('deterministic-verdict').dataset['verdict']).toBe('conditional');
    expect(within(decision).getByText('CONDITIONAL')).toBeTruthy();
    expect(within(decision).getByTestId('verdict-reasons').textContent).toMatch(/"npm test" failed before and after implementation .*pre-existing failure, not a regression/);
    expect(decision.textContent).not.toMatch(/Synthetic Bob narrative/);
    expect(decision.textContent).not.toMatch(/\bREADY\b/);
    expect(analysis.textContent).toContain('REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE');
    expect(analysis.textContent).toContain('Synthetic Bob narrative recommends:');
    expect(within(analysis).getByText('ready')).toBeTruthy();
    expect(within(analysis).getByTestId('verdict-discrepancy').textContent).toContain('DISAGREEMENT DETECTED');
    expect(within(analysis).getByTestId('transparency-note').textContent).toMatch(/validation finding is preserved.*advisory and cannot change the decision/);
    expect(screen.getByTestId('mission-status').textContent).toMatch(/complete/i);
    expect(screen.queryByTestId('failure-panel')).toBeNull();
  });

  it('7. replay rollback: available after the mission, then shown as a replay-only rollback that changed no files', async () => {
    const { calls } = mockReplayApi({ next: V('safe-fix@rolled-back') });
    showSession(V('safe-fix@end'));
    expect(screen.getByText(/Rollback · DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Roll back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    const outcome = await screen.findByTestId('replay-rollback-outcome');
    expect(outcome.textContent).toContain('DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK');
    expect(outcome.textContent).toContain('No file was restored or removed.');
    expect(outcome.textContent).toContain('restore src/pricing.ts');
    expect(screen.queryByTestId('rollback-outcome')).toBeNull(); // the live "files restored" message is never used
    expect(screen.getByTestId('mission-status').textContent).toMatch(/rolled back/i);
    expect(calls.find((c) => c.url.endsWith('/control'))?.body).toEqual({ action: 'rollback' });
  });

  it('9. replay screens never use live-Bob wording and show replay time instead of wall-clock time', () => {
    for (const name of Object.keys(snapshots.views) as ViewName[]) {
      showSession(V(name));
      const text = textWithoutDisclaimers();
      expect(text, name).not.toMatch(/\blive\b/i);
      expect(text, name).not.toMatch(/running bob|bob is executing|bob just completed|bob completed this task/i);
      expect(text, name).not.toMatch(/1970|1\/1\/1970/);
      expect(text, name).toMatch(/T\+\d+s/);
      cleanup();
    }
  });

  it('evidence drawer marks every replay item and never shows a Bob task id', () => {
    const v = V('safe-fix@end');
    render(
      <DisplayProvider mode={REPLAY_DISPLAY}>
        <EvidenceDrawer open onClose={() => undefined} evidence={v.evidence} tasks={v.tasks} loading={false} error={null} onRetry={() => undefined} />
      </DisplayProvider>,
    );
    expect(screen.getByText('Evidence (replay fixtures)')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /Observations/ }));
    const items = screen.getAllByTestId('evidence-item');
    expect(items.every((i) => i.textContent?.includes('Replay fixture'))).toBe(true);
    expect(document.body.textContent).toContain('none (replay fixture; IBM Bob not invoked)');
  });
});

describe('judge entry flow', () => {
  /** Mirrors App: the store's `view` decides between the live dashboard and the replay workspace. */
  function Shell({ onNewMission }: { onNewMission: () => void }): React.ReactElement {
    const view = useStore((s) => s.view);
    return view === 'replay' ? <ReplayWorkspace /> : <Dashboard onNewMission={onNewMission} />;
  }

  it('the initial state offers START DEMO REPLAY as the primary action and CREATE LIVE MISSION as secondary', () => {
    const onNewMission = vi.fn();
    render(<Shell onNewMission={onNewMission} />);
    const welcome = screen.getByTestId('welcome');
    const buttons = within(welcome).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['START DEMO REPLAY', 'CREATE LIVE MISSION']); // primary first
    expect(welcome.textContent).toContain('Deterministic demonstration — no live IBM Bob execution and no repository changes.');
    expect(within(screen.getByRole('list', { name: 'ForgeGuard workflow' })).getAllByRole('listitem').map((li) => li.textContent?.replace('→', '')))
      .toEqual(['Analysis', 'Plan', 'Implementation', 'Validation', 'Release decision']);
    expect(within(screen.getByRole('list', { name: 'Capabilities' })).getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['ANALYZE', 'VALIDATE', 'DECIDE']);
    expect(welcome.textContent).toContain('AI recommends. Evidence decides.');
    expect(screen.queryByTestId('replay-banner')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'CREATE LIVE MISSION' }));
    expect(onNewMission).toHaveBeenCalledTimes(1);
    expect(useStore.getState().view).toBe('live');
  });

  it('START DEMO REPLAY opens the scenario selector without starting a replay', async () => {
    const { calls } = mockReplayApi();
    render(<Shell onNewMission={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'START DEMO REPLAY' }));
    await screen.findByTestId('scenario-safe-fix');
    expect(screen.getByTestId('replay-selector')).toBeTruthy();
    expect(screen.getByTestId('replay-banner').textContent).toContain('DEMO REPLAY — NOT A LIVE BOB RUN');
    expect(screen.getByTestId('replay-start-hint').textContent).toMatch(/Safe Fix: plays automatically and pauses for your plan approval/);
    expect(calls.some((c) => c.method !== 'GET')).toBe(false); // nothing started until the user clicks START REPLAY
  });

  it('scenario cards explain each outcome; Bob Disagreement states evidence vs the synthetic narrative', async () => {
    mockReplayApi();
    render(<ReplayWorkspace />);
    await screen.findByTestId('scenario-bob-disagreement');
    const card = screen.getByTestId('scenario-bob-disagreement');
    expect(card.textContent).toContain('See evidence override an AI recommendation');
    expect(screen.getByTestId('scenario-note-bob-disagreement').textContent).toBe('Evidence says CONDITIONAL. Synthetic Bob narrative says READY.');
    // The frontend copy must agree with the fixture's own declared outcome.
    const fixture = snapshots.scenarios.find((s) => s.id === 'bob-disagreement')!;
    expect(fixture.expectedFinalState).toMatch(/^CONDITIONAL .*synthetic Bob narrative recommends READY/);
    expect(screen.getByTestId('scenario-note-safe-fix').textContent).toMatch(/release decision/);
    expect(screen.getByTestId('scenario-note-regression-blocked').textContent).toMatch(/blocked/);
    // Selection is shown in text, not only by colour.
    expect(screen.getByTestId('scenario-safe-fix').textContent).toContain('Selected');
    fireEvent.click(card);
    expect(card.textContent).toContain('Selected');
    expect(screen.getByTestId('scenario-safe-fix').textContent).not.toContain('Selected');
    expect(document.body.textContent).not.toMatch(/not available here/);
  });

  it('the new-mission dialog notes the live Bob requirement without claiming Bob is unavailable', () => {
    render(<NewMissionModal onClose={() => undefined} onSubmit={async () => ({ ok: false, status: 0, error: {} })} />);
    expect(screen.getByTestId('live-mission-note').textContent).toBe('Live missions require IBM Bob 2.0 and an available Bob account.');
    expect(screen.getByRole('dialog').textContent).not.toMatch(/unavailable|not available/i);
  });
});

describe('sidebar IBM Bob indicator', () => {
  const bobHealth = (): string => screen.getByTestId('bob-health').textContent ?? '';
  const renderShell = (): void => {
    useStore.setState({
      bobHealth: { data: { provider: 'shell', available: true, version: '2.0.5' }, loading: false, error: null, loaded: true },
      missions: { data: [mission({ status: 'created' })], loading: false, error: null, loaded: true },
    });
    render(<><Sidebar onNewMission={() => undefined} />{useStore.getState().view === 'replay' && <ReplayWorkspace />}</>);
  };

  it('shows NOT INVOKED in replay mode, never the availability, and keeps the replay banner', () => {
    mockReplayApi();
    useStore.setState({ view: 'replay' });
    renderShell();
    expect(bobHealth()).toMatch(/IBM Bob:\s*not invoked/i);
    expect(bobHealth()).not.toMatch(/available|2\.0\.5|running|live/i);
    expect(screen.queryByText(/Availability does not prove/)).toBeNull();
    expect(screen.getByTestId('replay-banner').textContent).toContain('DEMO REPLAY — NOT A LIVE BOB RUN');
    expect(screen.getByTestId('app-mode').textContent).toMatch(/Mode:\s*demo replay/i);
  });

  it('keeps the existing availability display on the live mission view', () => {
    mockReplayApi();
    renderShell();
    expect(bobHealth()).toMatch(/IBM Bob:\s*available 2\.0\.5/i);
    expect(bobHealth()).not.toMatch(/not invoked/i);
    expect(screen.getByText(/Availability does not prove/)).toBeTruthy();
    expect(screen.getByTestId('app-mode').textContent).toMatch(/Mode:\s*live mission/i);
  });

  it('shows the real unavailable state on the live view, and NOT INVOKED in replay regardless', () => {
    useStore.setState({ bobHealth: { data: { provider: 'shell', available: false, code: 'BOB_UNAVAILABLE' }, loading: false, error: null, loaded: true } });
    render(<Sidebar onNewMission={() => undefined} />);
    expect(bobHealth()).toMatch(/IBM Bob:\s*unavailable/i);
    act(() => useStore.getState().setView('replay'));
    expect(bobHealth()).toMatch(/IBM Bob:\s*not invoked/i);
  });

  it('updates the label when switching between replay and a live mission', async () => {
    mockReplayApi();
    renderShell();
    expect(bobHealth()).toMatch(/available 2\.0\.5/i);
    fireEvent.click(screen.getByTestId('open-replay'));
    expect(bobHealth()).toMatch(/not invoked/i);
    fireEvent.click(screen.getByText(mission({ status: 'created' }).issue_text));
    await waitFor(() => expect(useStore.getState().view).toBe('live'));
    expect(bobHealth()).toMatch(/available 2\.0\.5/i);
    expect(bobHealth()).not.toMatch(/not invoked/i);
  });
});

describe('refresh survival', () => {
  it('10. a replay in progress is restored after a page reload; a reset session is forgotten', async () => {
    sessionStorage.setItem(REPLAY_SESSION_KEY, 'replay-session-001');
    const { calls } = mockReplayApi({ current: V('safe-fix@gate') });
    await act(async () => { expect(await useReplayStore.getState().rehydrate()).toBe(true); });
    render(<ReplayWorkspace />);
    expect(screen.getByTestId('replay-status').textContent).toMatch(/waiting for approval/i);
    expect(calls[0]?.url).toBe('/api/replay/replay-session-001');
    cleanup();

    useReplayStore.setState(initialReplay, true);
    mockReplayApi({});
    await act(async () => { expect(await useReplayStore.getState().rehydrate()).toBe(false); });
    expect(sessionStorage.getItem(REPLAY_SESSION_KEY)).toBeNull();
  });
});
