/**
 * Demo replay: deterministic, fixture-driven, isolated from Bob, validation commands,
 * git and the mission database. Forbidden modules are wrapped in call-recording spies.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Record<string, number> = {};
const hit = (name: string): void => { calls[name] = (calls[name] ?? 0) + 1; };
const wrap = <T extends (...a: never[]) => unknown>(name: string, fn: T): T =>
  ((...args: never[]) => { hit(name); return fn(...args); }) as T;

vi.mock('child_process', async (orig) => {
  const m = await orig<typeof import('child_process')>();
  return {
    ...m,
    spawn: wrap('child_process.spawn', m.spawn), exec: wrap('child_process.exec', m.exec),
    execFile: wrap('child_process.execFile', m.execFile), fork: wrap('child_process.fork', m.fork),
    execSync: wrap('child_process.execSync', m.execSync), execFileSync: wrap('child_process.execFileSync', m.execFileSync),
    spawnSync: wrap('child_process.spawnSync', m.spawnSync),
  };
});
vi.mock('../src/bob/BobShellClient', async (orig) => {
  const m = await orig<typeof import('../src/bob/BobShellClient')>();
  return { ...m, BobShellClient: class extends m.BobShellClient { constructor(...a: ConstructorParameters<typeof m.BobShellClient>) { hit('BobShellClient'); super(...a); } } };
});
vi.mock('../src/bob/BobApiClient', async (orig) => {
  const m = await orig<typeof import('../src/bob/BobApiClient')>();
  return { ...m, BobApiClient: class extends m.BobApiClient { constructor(...a: ConstructorParameters<typeof m.BobApiClient>) { hit('BobApiClient'); super(...a); } } };
});
vi.mock('../src/bob/BobClient', async (orig) => {
  const m = await orig<typeof import('../src/bob/BobClient')>();
  return { ...m, createBobClient: wrap('createBobClient', m.createBobClient) };
});
vi.mock('../src/pipeline/MissionOrchestrator', async (orig) => {
  const m = await orig<typeof import('../src/pipeline/MissionOrchestrator')>();
  return {
    ...m,
    startMission: wrap('startMission', m.startMission),
    executeCommand: wrap('executeCommand', m.executeCommand),
    MissionOrchestrator: class extends m.MissionOrchestrator { constructor(...a: ConstructorParameters<typeof m.MissionOrchestrator>) { hit('MissionOrchestrator'); super(...a); } },
  };
});
vi.mock('../src/git/snapshot', async (orig) => {
  const m = await orig<typeof import('../src/git/snapshot')>();
  return { ...m, createAnchor: wrap('createAnchor', m.createAnchor), restoreAnchor: wrap('restoreAnchor', m.restoreAnchor), recordResultSnapshot: wrap('recordResultSnapshot', m.recordResultSnapshot) };
});
vi.mock('../src/git/git', async (orig) => {
  const m = await orig<typeof import('../src/git/git')>();
  return { ...m, git: wrap('git', m.git), gitOk: wrap('gitOk', m.gitOk) };
});
vi.mock('../src/db/database', async (orig) => {
  const m = await orig<typeof import('../src/db/database')>();
  return { ...m, getDatabase: wrap('getDatabase', m.getDatabase) };
});
const events: Array<{ type: string; missionId: string; payload: Record<string, unknown> }> = [];
vi.mock('../src/ws/EventBus', () => ({ emitEvent: (e: { type: string; missionId: string; payload: Record<string, unknown> }) => events.push(e) }));

process.env['DB_PATH'] = ':memory:';
const { execFileSync } = await import('child_process');
const { createApp } = await import('../src/app');
const { FIXTURES, resetAllReplays, replaySessionCount, STEP_MIN_MS } = await import('../src/replay/ReplayStore');
const { buildReplayView, validateFixture } = await import('../src/replay/ReplayEngine');

const DEMO_APP = path.resolve(__dirname, '../../demo-app');
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer(createApp({}));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { resetAllReplays(); await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { for (const k of Object.keys(calls)) delete calls[k]; events.length = 0; });
afterEach(() => { resetAllReplays(); vi.useRealTimers(); });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function call(method: string, p: string, body?: unknown): Promise<{ status: number; body: Json; text: string }> {
  const res = await fetch(`${base}${p}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) as Json : {}, text };
}
const control = (id: string, action: string, extra: Json = {}) => call('POST', `/api/replay/${id}/control`, { action, ...extra });

/** Start a scenario, pause it, and step through every step (approving at the gate). */
async function playToEnd(scenario: string): Promise<Json> {
  const started = await call('POST', `/api/replay/${scenario}/start`);
  expect(started.status).toBe(201);
  const id = started.body['replayId'] as string;
  let v = (await control(id, 'pause')).body;
  for (let guard = 0; guard < 100 && v['status'] !== 'finished'; guard++) {
    v = (await control(id, v['status'] === 'awaiting_approval' ? 'approve' : 'next')).body;
  }
  expect(v['status']).toBe('finished');
  return v;
}
const stripSession = (v: Json): Json => { const { replayId: _r, ...rest } = v; return rest; };
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FORBIDDEN_CALLS = ['BobShellClient', 'BobApiClient', 'createBobClient', 'MissionOrchestrator', 'startMission', 'executeCommand',
  'createAnchor', 'restoreAnchor', 'recordResultSnapshot', 'git', 'gitOk', 'getDatabase',
  'child_process.spawn', 'child_process.exec', 'child_process.execFile', 'child_process.fork', 'child_process.execSync', 'child_process.execFileSync', 'child_process.spawnSync'];

describe('replay API', () => {
  it('1. lists the scenarios without internal details', async () => {
    const r = await call('GET', '/api/replay/scenarios');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      expect.objectContaining({ id: 'safe-fix', title: 'Safe Fix', purpose: 'Complete end-to-end successful engineering workflow' }),
      expect.objectContaining({ id: 'regression-blocked', title: 'Regression Blocked', purpose: 'Post-change validation exposes a regression' }),
      expect.objectContaining({ id: 'bob-disagreement', title: 'Bob Disagreement', purpose: 'Model recommendation conflicts with deterministic evidence' }),
    ]);
    for (const s of r.body as unknown as Json[]) expect(Object.keys(s).sort()).toEqual(['durationSeconds', 'expectedFinalState', 'id', 'purpose', 'steps', 'title']);
    expect(r.text).not.toMatch(/fixtures|\.json|[A-Za-z]:\\/);
  });

  it('2. starting a replay returns a labelled, playing session at step 0', async () => {
    const r = await call('POST', '/api/replay/safe-fix/start');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      replay: true, label: 'DEMO REPLAY — NOT A LIVE BOB RUN', status: 'playing', position: 0, speed: 1,
      mission: { id: 'replay-mission-safe-fix', status: 'created', repo_path: 'replay://demo-app' },
    });
    expect(r.body['replayId']).toMatch(/^replay-session-\d{3}$/);
    expect(events.at(-1)).toMatchObject({ type: 'replay.updated', missionId: 'replay-mission-safe-fix' });
  });

  it('rejects unknown scenarios, path-like ids, bad actions and bad speeds', async () => {
    expect((await call('POST', '/api/replay/nope/start')).body['code']).toBe('REPLAY_SCENARIO_NOT_FOUND');
    expect((await call('POST', '/api/replay/..%2Fsafe-fix/start')).status).toBe(404);
    expect((await call('POST', '/api/replay/__proto__/start')).status).toBe(404);
    expect((await call('GET', '/api/replay/replay-session-999')).status).toBe(404);
    const id = (await call('POST', '/api/replay/safe-fix/start')).body['replayId'] as string;
    expect((await control(id, 'rm -rf /')).body['code']).toBe('INVALID_REPLAY_ACTION');
    expect((await control(id, 'speed', { speed: 3 })).body['code']).toBe('INVALID_REPLAY_SPEED');
  });
});

describe('isolation', () => {
  it('3/4/5. a full replay of every scenario (incl. approval and rollback) never touches Bob, validation, git, the DB or child processes', async () => {
    for (const scenario of FIXTURES.keys()) {
      const v = await playToEnd(scenario);
      if (v['rollback']['available']) expect((await control(v['replayId'], 'rollback')).status).toBe(200);
    }
    for (const name of FORBIDDEN_CALLS) expect(calls[name] ?? 0, name).toBe(0);
    expect(events.every((e) => e.type === 'replay.updated')).toBe(true); // no production mission/phase/agent events
  });

  it('positive control: the recording spies do register real calls', async () => {
    const { createBobClient } = await import('../src/bob/BobClient');
    const { git } = await import('../src/git/git');
    const { getDatabase } = await import('../src/db/database');
    // createBobClient is the only factory for Bob clients (it require()s BobShellClient lazily,
    // which module mocks cannot intercept), so the createBobClient spy is the reliable Bob gate.
    try { createBobClient(); } catch { /* lazy require is not resolvable under the test transform */ }
    await git(DEMO_APP, ['--version']);
    getDatabase();
    execFileSync('git', ['--version']);
    for (const name of ['createBobClient', 'git', 'child_process.spawn', 'getDatabase', 'child_process.execFileSync']) {
      expect(calls[name] ?? 0, name).toBeGreaterThan(0);
    }
  });

  it('replay modules do not import any execution path', () => {
    const dir = path.resolve(__dirname, '../src/replay');
    const sources = [...fs.readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => path.join(dir, f)), path.resolve(__dirname, '../src/routes/replay.ts')];
    for (const file of sources) {
      const imports = [...fs.readFileSync(file, 'utf-8').matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const imp of imports) {
        expect(imp, `${path.basename(file)} imports ${imp}`).not.toMatch(/bob\/|MissionOrchestrator|TaskManager|git\/|child_process|db\/|rollback|PhaseRunner/);
      }
    }
  });

  it('12. replaying does not modify the demo-app Git state', async () => {
    const state = (): string[] => [
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: DEMO_APP, encoding: 'utf-8' }),
      execFileSync('git', ['status', '--porcelain'], { cwd: DEMO_APP, encoding: 'utf-8' }),
      execFileSync('git', ['for-each-ref'], { cwd: DEMO_APP, encoding: 'utf-8' }),
    ];
    const before = state();
    for (const k of Object.keys(calls)) delete calls[k];
    for (const scenario of FIXTURES.keys()) {
      const v = await playToEnd(scenario);
      if (v['rollback']['available']) await control(v['replayId'], 'rollback');
    }
    expect(calls['child_process.execFileSync'] ?? 0).toBe(0);
    expect(state()).toEqual(before);
    expect(before[0]!.trim()).toBe('fc6794e3e2e1c0b572c53c0a4026a62bac3c8a1f');
  });
});

describe('determinism', () => {
  it('6. two sessions of the same scenario produce identical states at every step', async () => {
    for (const scenario of FIXTURES.keys()) {
      const a = (await call('POST', `/api/replay/${scenario}/start`)).body['replayId'] as string;
      const b = (await call('POST', `/api/replay/${scenario}/start`)).body['replayId'] as string;
      await control(a, 'pause'); await control(b, 'pause');
      for (let i = 0; i < 40; i++) {
        const va = (await call('GET', `/api/replay/${a}`)).body;
        const vb = (await call('GET', `/api/replay/${b}`)).body;
        expect(stripSession(va)).toEqual(stripSession(vb));
        if (va['status'] === 'finished') break;
        const action = va['status'] === 'awaiting_approval' ? 'approve' : 'next';
        await control(a, action); await control(b, action);
      }
    }
  });

  it('the view is a pure function of (fixture, state) and uses replay time, not wall-clock time', () => {
    const f = FIXTURES.get('safe-fix')!;
    const s = { position: 10, approved: true, rolledBack: false };
    expect(buildReplayView(f, s)).toEqual(buildReplayView(f, s));
    const v = buildReplayView(f, s);
    const stamps = [v.mission.created_at, v.mission.updated_at, ...v.phases.flatMap((p) => [p.started_at, p.completed_at]), ...v.evidence.map((e) => e.created_at)].filter(Boolean);
    expect(stamps.every((t) => (t as string).startsWith('1970-01-01T00:00:'))).toBe(true);
  });

  it('the frontend replay test snapshots are exactly the current engine output', async () => {
    const { replaySnapshots } = await import('../src/replay/snapshots');
    const file = path.resolve(__dirname, '../../frontend/src/test/replay-views.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')), 'run `npm run replay:snapshots`').toEqual(JSON.parse(JSON.stringify(replaySnapshots())));
  });

  it('every fixture is structurally valid and its declared outcome matches the verdict the real logic computes', () => {
    for (const f of FIXTURES.values()) {
      expect(validateFixture(f), f.id).toEqual([]);
      const end = buildReplayView(f, { position: f.timeline.length - 1, approved: true, rolledBack: false });
      expect(end.verdict.verdict, f.id).toBe(f.expectedVerdict);
    }
  });
});

describe('scenario outcomes', () => {
  it('7. safe fix reaches READY; Bob narrative agrees; replay rollback is labelled and changes no files', async () => {
    const v = await playToEnd('safe-fix');
    expect(v['verdict']['verdict']).toBe('ready');
    expect(v['mission']['status']).toBe('complete');
    expect(v['phases'].map((p: Json) => `${p['phase_name']}:${p['status']}`)).toEqual([
      'repo_understanding:completed', 'parallel_analysis:completed', 'change_plan:completed',
      'implementation:completed', 'validation:completed', 'release_report:completed',
    ]);
    expect(v['validationRuns']).toHaveLength(8);
    const report = JSON.parse(v['mission']['release_report']);
    expect(report).toMatchObject({ verdict: 'ready', bobAssessment: 'ready', agreesWithVerdict: true, discrepancy: null });
    expect(report.bobNarrative.label).toBe('REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE');
    expect(v['rollback']).toMatchObject({ available: true });

    const rolled = (await control(v['replayId'], 'rollback')).body;
    expect(rolled['mission']['status']).toBe('rolled_back');
    expect(rolled['rollbackOutcome']).toMatchObject({ ok: true, replay: true, removed: [], restored: [], wouldRestore: ['src/pricing.ts', 'tests/pricing.test.ts'] });
    const rb = rolled['evidence'].find((e: Json) => e['phase_name'] === 'rollback');
    expect(rb['content']).toContain('DEMO REPLAY ROLLBACK — NOT A LIVE REPOSITORY ROLLBACK');
    expect(rb['content']).toContain('"filesChanged": 0');
    expect((await control(v['replayId'], 'rollback')).body['code']).toBe('ROLLBACK_ALREADY_DONE');
  });

  it('8. regression scenario reaches BLOCKED with the regression identified', async () => {
    const v = await playToEnd('regression-blocked');
    expect(v['verdict']).toMatchObject({ verdict: 'blocked', implementationSucceeded: true });
    expect(v['verdict']['commands'].find((c: Json) => c['command'] === 'npm test')).toMatchObject({ baseline: 'pass', post: 'fail', classification: 'regression' });
    expect(v['verdict']['reasons']).toEqual(['"npm test" exited 1 after implementation but passed in the baseline (regression)']);
    expect(v['mission']).toMatchObject({ status: 'failed' });
    expect(v['mission']['error_message']).toMatch(/^Phase "validation" failed: Release blocked:/);
    expect(v['phases'].find((p: Json) => p['phase_name'] === 'release_report')).toMatchObject({ status: 'skipped', error_message: 'Blocked: phase "validation" failed' });
    expect(v['mission']['release_report']).toBeNull();
    expect(v['rollback']).toMatchObject({ available: true });
  });

  it('9. disagreement scenario (live-reachable): the deterministic CONDITIONAL verdict stays authoritative over a READY narrative', async () => {
    const v = await playToEnd('bob-disagreement');
    expect(v['verdict']['verdict']).toBe('conditional');
    expect(v['verdict']['commands'].find((c: Json) => c['command'] === 'npm test')).toMatchObject({ baseline: 'fail', post: 'fail', classification: 'preexisting_failure' });
    expect(v['mission']['status']).toBe('complete');
    // As in the live pipeline, the narrative comes from a completed Phase 6.
    expect(v['phases'].find((p: Json) => p['phase_name'] === 'release_report')).toMatchObject({ status: 'completed' });
    const report = JSON.parse(v['mission']['release_report']);
    expect(report).toMatchObject({ verdict: 'conditional', bobAssessment: 'ready', agreesWithVerdict: false });
    expect(report.bobNarrative.label).toBe('REPLAY FIXTURE — SYNTHETIC BOB NARRATIVE');
    expect(report.discrepancy).toMatch(/assessed "ready" but the deterministic verdict from validation evidence is "conditional"; the deterministic verdict is used/);
    expect(v['scenario']['transparencyNote']).toMatch(/SYNTHETIC BOB NARRATIVE.*advisory/s);
    expect(v['evidence'].some((e: Json) => String(e['content']).includes('Verdict discrepancy'))).toBe(true);
  });

  it('no scenario can show a Bob narrative after a blocked verdict (Phase 6 never follows BLOCKED)', () => {
    for (const f of FIXTURES.values()) {
      const end = buildReplayView(f, { position: f.timeline.length - 1, approved: true, rolledBack: false });
      if (end.verdict.verdict === 'blocked') {
        expect(end.mission.release_report, f.id).toBeNull();
        expect(end.phases.find((p) => p.phase_name === 'release_report')?.status, f.id).toBe('skipped');
      }
    }
    const bad = { ...FIXTURES.get('regression-blocked')!, bobNarrative: { releaseReadiness: 'ready', summary: 's', recommendation: 'deploy', remainingRisks: [] } };
    expect(validateFixture(bad)).toEqual(expect.arrayContaining([
      'bobNarrative requires a completed release_report phase',
      'a blocked scenario cannot have a Bob narrative (Phase 6 does not run)',
    ]));
  });
});

describe('identifiers, labels and secrets', () => {
  it('10. replay identifiers are clearly replay identifiers, never real-looking Bob or UUID ids', async () => {
    const v = await playToEnd('safe-fix');
    const ids = [v['mission']['id'], ...['phases', 'tasks', 'evidence', 'validationRuns'].flatMap((k) => v[k].map((x: Json) => x['id']))];
    expect(ids.every((id: string) => id.startsWith('replay-'))).toBe(true);
    expect(v['tasks'].map((t: Json) => t['id'])).toContain('replay-task-001');
    expect(JSON.stringify(v)).not.toMatch(UUID);
    for (const t of v['tasks']) expect(t['bob_provider']).toBe('replay');
    const diagnostics = v['evidence'].filter((e: Json) => String(e['content']).includes('"forgeguardTaskId"')).map((e: Json) => JSON.parse(e['content']));
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d: Json) => d['bobTaskId'] === null && d['replayFixture'] === true)).toBe(true);
    expect(v['evidence'].every((e: Json) => e['replay'] === true)).toBe(true);
    for (const r of v['validationRuns']) expect(r['stdout']).toMatch(/^\[REPLAY FIXTURE — command not executed/);
  });

  it('responses expose no filesystem paths, home directory, Bob data or environment secrets', async () => {
    process.env['BOBSHELL_API_KEY'] = 'sk-replay-should-never-appear';
    const v = await playToEnd('bob-disagreement');
    const text = JSON.stringify(v);
    expect(text).not.toContain(os.homedir());
    expect(text).not.toMatch(/\.bob[\\/]|bob\.db|[A-Za-z]:\\\\/);
    expect(text).not.toContain('sk-replay-should-never-appear');
  });

  it('11. reset removes the replay state', async () => {
    const id = (await call('POST', '/api/replay/safe-fix/start')).body['replayId'] as string;
    expect(replaySessionCount()).toBe(1);
    expect((await call('DELETE', `/api/replay/${id}`)).body).toEqual({ reset: true, replayId: id });
    expect((await call('GET', `/api/replay/${id}`)).body['code']).toBe('REPLAY_NOT_FOUND');
    expect(replaySessionCount()).toBe(0);
  });
});

describe('playback', () => {
  it('plays on its own clock, stops at the approval gate, and honours pause, speed, next and restart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const id = (await call('POST', '/api/replay/safe-fix/start')).body['replayId'] as string;
    await vi.advanceTimersByTimeAsync(1000);
    const p1 = (await call('GET', `/api/replay/${id}`)).body['position'] as number;
    expect(p1).toBeGreaterThan(0);

    await control(id, 'pause');
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await call('GET', `/api/replay/${id}`)).body['position']).toBe(p1);

    await control(id, 'speed', { speed: 4 });
    await control(id, 'play');
    await vi.advanceTimersByTimeAsync(20_000);
    const gated = (await call('GET', `/api/replay/${id}`)).body;
    expect(gated).toMatchObject({ status: 'awaiting_approval', awaitingApproval: true, speed: 4 });
    expect(gated['mission']['status']).toBe('awaiting_approval');
    expect((await control(id, 'next')).body['code']).toBe('APPROVAL_REQUIRED');

    await control(id, 'approve');
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await call('GET', `/api/replay/${id}`)).body['status']).toBe('finished');

    const restarted = (await control(id, 'restart')).body;
    expect(restarted).toMatchObject({ position: 0, status: 'playing' });
    expect(STEP_MIN_MS).toBeGreaterThan(0);
  });
});
